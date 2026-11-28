[English](README.md) | [中文](README.zh-CN.md)

# magpie-aws-quick —— 在 magpie 里用你自己的 Amazon Quick（AWS Quick）账号

把**你自己**的 Amazon Quick 登录态（浏览器 OAuth 或桌面端）接成 [magpie](https://github.com/yetone/magpie) 的一个 provider（`aws-quick`），
这样经 magpie 路由的 Claude Code、Codex、Gemini CLI、OpenCode 等 Agent 都能用上 Quick 背后的模型
（以 `magpie models | grep aws-quick` 列出的为准）。

> **推荐客户端：Claude Code 或 pi（pi-agent）。** 插件主要针对这两个客户端开发。在 Claude Code 里，
> 工具调用、跨轮复用 Quick 会话、中断和大文件写入都做过端到端测试；pi 发的会话亲和头会用来持续复用同一个
> Quick 会话。其他客户端也能用，只是测得少一些。

> **想直接用 Quick 原生桌面端？** 推荐 [aws-quick-manager](https://github.com/httpdone/aws-quick-manager)：
> 在官方 Quick 客户端里一键切换账号，通过 Quick 的云端接口在账号之间转移会话，不需要反向代理。

> ⚠️ 仅供个人使用自己的账号。这是驱动 Amazon Quick 桌面客户端的内部双向 WebSocket 协议
> （非公开 API），很可能违反 AWS 服务条款，账号存在被限制/封禁的风险，后果自负。

## 工作方式

magpie 有真正的插件机制：它在 Bun 里加载 **OpenCode provider 插件**。本项目就是这样一个插件：

```
Agent ──(Anthropic / Responses / Chat / Gemini)──▶ magpie 网关 127.0.0.1:3425
      ──(OpenAI Chat Completions)──▶ 本插件的 fetch ──▶ wss://<qbs-cell>/streaming/quickwork-chat-bidirectional-stream
```

关键点：**不需要抓包、不需要代理、不需要改 app**。Amazon Quick 桌面端本身就内置一个
Python 后端（`quickwork-agent`，打包在 `resources/agent.zip` 里），以 `--outpost-only`
模式独立运行后会在 `127.0.0.1:<port>` 暴露 `/health`、`/auth/status`、`/auth/sncs-session`、
`/local/outpost-id` 等本地接口，并能读到桌面端保存在系统凭据存储里的登录态。

插件做的事：

1. **找到并启动 outpost**：优先用 app 已解压到 userData 的 `quickwork-agent`；找不到就把
   `resources/agent.zip` 解压到临时目录再跑。用**我们自己生成的 instance token** 通过
   stdin 交给子进程（与 Electron 主进程 `AgentBridge` 的契约一致），等 `/health` 就绪。
2. **取会话**：`GET /auth/sncs-session` 拿到 `{id_token, ws_host, actor_arn, …}`，
   `GET /local/outpost-id` 拿到设备 id；按 `usable_until` 缓存，临期自动重取。
3. **连聊天 WS**：`wss://<ws_host>/streaming/quickwork-chat-bidirectional-stream`
   （query: `surfaceType`/`token`/`outpostId`/`workingSessionId`/`channel`），
   发 `session_connect`（等 `session_established`/`connected` 应答），再发 `user_message`。
   上行是 `{"eventType":"rawInputEvent","payload":{"payload":base64(inner JSON)}}` 的
   二进制帧；下行是 AWS event-stream 帧（`:event-type=rawOutputEvent`，body 里同样是
   base64 包的 inner JSON）。每 25s 发 `ping`。
4. **协议翻译**：OpenAI 的 `messages` 渲染成 Quick 的 `text`（见下）——
   例外是 system prompt，它走独立的 `user_message.custom_prompt` 字段
   （已实测生效）；下行的 `text_delta`/`thinking_delta`/`turn_usage`/
   `message_complete` 转成 OpenAI 的 `content`/`reasoning_content`/`usage`。
   一个 user turn 以 `message_complete`（`continuation_expected !== true`）
   结束——与桌面渲染端判定一致。
5. **会话复用（默认开启）**：账号、网关会话键和消息 key 前缀共同决定是否续接
   同一 thread——见下文 [会话复用](#会话复用thread-reuse)。

设备 ID：官方桌面端连接时总会把 profile 里的 `device_id` 作为 `outpostId` 发出去，所以直连会话也发一个按账号固定的 ID，不再发空值。
凭据管理器登录直接用桌面端 profile 里的 `device_id`（只读）；OAuth 账号在登录时生成一个 UUID，存在账号记录里，刷新令牌和重新登录都保持不变。
大图上传投递时也用同一个 ID。不同账号不共用 ID，同一账号的 ID 不会更换。设 `stableDeviceId: false` 可退回空值。
本地 outpost 模式使用 Quick 自带 agent 报告的 ID；agent 会继承环境变量 `QUICKWORK_BASE` / `QUICKWORK_ROOT`。

### 会话复用（thread reuse）

Quick 在服务端按 `thread_id` 保存会话历史，而 OpenAI 客户端每次请求都重发
完整 transcript。本插件只做一种判定：

- **一个 thread 就是一段消息 key 前缀** —— 每条 user/tool 消息贡献一个哈希
  （角色、tool_call_id、工具名、归一化后的正文）；assistant 消息统一记为
  通配符 `assistant`。客户端重发它自己渲染的回复（裁剪、附加 note、重新生成
  调用 id、丢掉 thinking）仍然命中；命中时只把新增的 user/tool 尾部发给上游，
  更早的历史由 Quick 服务端保存。
- **历史变化就换 thread** —— 编辑、回退或 compaction 改写了某条
  user/tool 消息，它的 key 就变了，已存前缀不再匹配，插件新建 thread 并重发
  当前 transcript。继续旧 thread 就是让模型基于客户端早已压缩掉的 500k token
  历史工作。新尾部里出现 assistant 消息的请求同样不匹配：客户端手里的历史比
  已存 thread 描述的更多。
- **thread 身份只看账号、网关会话键和消息前缀** —— system prompt、agent_mode、
  工具列表、思考强度都不参与。Claude Code 会在会话中途改 system prompt
  （memory、billing、ToolSearch）或换模型档位，这些变化不该丢掉 thread。
- **后台 fork 与子代理分开** —— 已知的 Claude Code 下一步建议、离开总结和标题
  请求使用一次性 Quick thread，不取走或提交共享会话缓存，也不等待主会话的 lane。
  普通 `x-magpie-subagent` 分支使用独立分区，仍可多轮复用。已知用途的
  `query_source`/`querySource` 请求元数据或显式 `x-magpie-query-source` 适配头
  优先；该头是适配约定，不代表所有网关都已透传。无元数据时只识别当前请求中
  严格的 Claude 提示词特征，不靠短消息、没工具或历史引用猜测。客户端提示词
  改版后，可能需要更新识别规则或显式提供元数据。
- **命中即取走** —— 匹配成功会把条目从缓存里移除。发送前的准备失败可以归还；
  一旦可能已经发送 `user_message`，取消、超时或状态不确定的失败就使旧前缀失效，
  下一次请求安全新建 thread。Quick 的 `stop_generation` 只是尽力停止，
  不会回滚服务端历史。
- **有界内存** —— 条目空闲 24 小时过期，LRU 上限 200 个 thread。缓存持久化到
  `thread-sessions.json`（账号身份、会话键、消息 key 哈希、thread id 和工具名，
  无消息内容），插件重载后仍可续接。

这比旧版的三级判定（哈希链 + 模糊锚点 + 会话键兜底）简单得多，也去掉了
“跨会话 session key 碰撞”和“compaction 后继续续旧 thread”两类问题。代价是：
客户端 compaction 后不再有服务端旧上下文，模型要靠压缩后的历史重新建立状态——
这正是 `magpie-aws-quick-bridge` 的做法，也是它上下文不会膨胀到 500k 的原因。

### 模型：agent_mode，不是模型 id

Quick 的 `user_message` 用 `agent_mode` 选择档位，服务端再路由到具体模型
（`turn_usage` 里有 `resolved_model_id`/`served_model_id`）：

| magpie 模型 id | agent_mode | 实测 resolved_model_id（示例） |
|---|---|---|
| `fast` | fast | `us.anthropic.claude-haiku-5-5` |
| `balanced` | balanced | （随服务端路由） |
| `smart` | smart | `us.anthropic.claude-opus-5-5` |
| `advanced` | advanced | （服务端可能归一到 smart） |

`X-Magpie-Effort` 头（或 body 的 `reasoning_effort`/`thinking_effort`）映射到
`thinking_effort`：`off/low/medium/high/max`。`max` 默认会被压成 `high`
（`thinkingEffortCap`）；把上限设成 `max` 才会原样透传。

## 安装

### 1. 前提

- **magpie**（OpenCode 插件宿主）。
- **两种登录方式任选其一**（`magpie login` 时选择）：
  - **账号登录（浏览器 OAuth）**——不需要桌面端。插件在你浏览器里重放桌面端
    自己的 OIDC+PKCE 登录流程，拿到 token 后直接连云端聊天。没装桌面端、
    没有管理员权限的机器也能用。
  - **本地凭据**——**Amazon Quick 桌面版**已安装并**登录**（Windows 默认装在
    `%LOCALAPPDATA%\Programs\quickwork\`，即 `C:\Users\<用户名>\AppData\Local\Programs\quickwork\`；
    macOS 为 `/Applications/Amazon Quick.app`）。Windows 上插件直接从
    Credential Manager 读取应用保存的会话——**不需要 agent.exe、不需要
    outpost**；token 过期走 OIDC 自动续期并写回，桌面端不受影响。其他平台
    （或读取失败时）回退到拉起内置 `quickwork-agent --outpost-only`，复用
    应用登录态——**不需要**桌面端保持运行，登录态存在系统凭据存储里。
- **Node ≥ 22.18**：跑测试和 `bin/serve.mjs` 时需要（它们直接 import
  TypeScript 源码，Node 从 22.18 起默认开启类型擦除）；插件本身由 magpie 的
  Bun 宿主加载，运行时零第三方依赖，`typescript`/`@types/node` 只用于开发。

### 2. 安装插件

```bash
magpie plugin add magpie-aws-quick   # 从 npm 安装；也可以写本地目录或 git URL
magpie login aws-quick              # 按提示选择登录方式
```

在 magpie 应用里，也可以到 **插件** 页搜索 "Amazon Quick" 直接安装。

**替代方案：独立 OpenAI 兼容代理**——`node bin/serve.mjs` 把同一个适配层
以 OpenAI Chat Completions 形式挂在 `127.0.0.1:$PORT/v1`（默认 3426），
供不走 magpie 的客户端使用，或通过
`magpie provider add --base-url http://127.0.0.1:3426/v1` 把 Quick 作为
自定义 provider 接入。参数见文件头（建议设置 `PROXY_TOKEN` 鉴权）。
`QUICK_REQUEST_TIMEOUT_MS` 设置同一个固定请求总预算（`0` 关闭），
`QUICK_MAX_TURN_ATTEMPTS` 设置共享生成次数上限。代理与插件使用相同的规则读取
会话、子代理、思考强度和显式用途适配头。

**两种登录方式**

- **账号登录（浏览器 OAuth）**：打开 `quick.aws.com/sn` 登录页，插件在本地
  回调端口接住授权码，自行完成动态客户端注册 + code 换 token + user-info，
  然后把统一凭据记录 `{ tokens: { access_token, refresh_token, id_token, expires_at }, client: { client_id, client_secret, … }, tenant_url, ws_host, actor_arn, … }` 存到
  `%APPDATA%\magpie-aws-quick\oauth-sessions.json`（Windows）/
  `~/.config/magpie-aws-quick/`（Linux）/
  `~/Library/Application Support/magpie-aws-quick/`（macOS），权限 `0600`。
  约 1 小时有效的 id_token 过期时用存的 refresh_token 自动续期（轮换后的
  refresh_token 也会写回文件）。请求时**不再拉起 outpost**，WS 直连租户的
  `ws_host`。
- **复制登录地址（不自动打开浏览器）**：同样的浏览器 OAuth 流程，但 magpie
  不会打开任何东西——把链接复制到你用来登录 Amazon 的浏览器里打开，登录完
  把地址栏里的完整地址粘贴到 magpie 显示的输入框。如果那个浏览器在别的
  电脑上，访问不到 `127.0.0.1` 回调：第一次粘贴会记下账号信息并提示再来
  一次，第二次粘贴即可完成（保存 15 分钟内有效）。
- **本地凭据**：Windows 上直接读 Credential Manager 里的会话直连聊天
  （OIDC 自动续期 + 写回，桌面端 token 保持有效）；其他平台或读取失败时
  回退到拉起内置 outpost 并调用 `/auth/sncs-session` 校验；未登录会明确
  报错提示先去登录。

### 账号卡片上的用量

插件实现了 magpie 的 `auth.usage` 钩子，账号卡片和 **Usage** 页会显示 Quick
额度：agent 小时数已用多少、套餐总量、套餐名（如 *Quick Lite (free trial)*）
和试用到期时间。数据来自租户数据面的 `getAvailableEntitlementUnits`，用的是
账号自己的 token，和桌面端用量组件的数字一致；重置时间按桌面端的算法取
下个月 1 号。

### 选项

少数插件选项可以调请求行为（`magpie plugin options aws-quick '{…}'`）：

- `headerWaitMs`（默认 `10000`）：流式请求在 Quick 给出首个输出**或**超过
  该时长后返回响应头——Quick 跑自带工具时可能长时间静默，而网关对响应头
  的等待是有上限的。`0` 表示和以前一样等到首个输出。
- `requestTimeoutMs`（默认 `600000`，10 分钟）：单次插件/代理调用的固定总预算，
  从读取 body、准备后端和账号身份之前开始，覆盖上传、review、建连等待、生成
  及内部重试；有进展也不会重置。`0` 显式关闭。SSE 响应头发出前到期报 HTTP 503；
  发出后用 code 为 503 的 SSE error 加 `[DONE]` 结束。客户端取消单独记为 499。
- `idleTimeoutMs`（默认 `300000`）：生成期间该时长没有 Quick 进展
  （keepalive 不算）就以 503 `timeout` 中止；它与固定总期限相互独立，`0`
  只关闭这个空闲 watchdog。发送后取消或超时会尽力给该 thread 发
  `stop_generation`，不关闭其他线程共用的 socket。
- `maxTurnAttempts`（默认 `3`，最少 `1`）：审核、坏工具调用、空回答及新线程重试
  共用的生成尝试次数上限。调大下面某一项重试选项，也不能突破该上限或总期限。
- `showQuickTools`（默认 `true`）：把 Quick 自带工具的 `tool_start` 以
  `[Quick: <名称>]` 推理行的形式透出，长时间 agentic 轮次不再看起来像卡死；
  `false` 隐藏。
- `stableDeviceId`（默认 `true`）：直连会话把按账号固定的设备 ID 作为
  `outpostId` 发送（见上文"设备 ID"）；`false` 改发空值。
- `keepSessions`（默认 `false`）：设为 `true` 时聊天会出现在 Amazon Quick
  的会话列表和记忆里；默认所有聊天都是 incognito。也接受旧桥设置文件里的
  `keep_sessions` 拼写。
- `sessionReuse`（默认 `true`）：跨轮续接 Quick thread；设为 `false` 则每个
  请求都开新 thread。`sessionTtlMs`（默认 24 小时）和 `sessionMax`（默认
  200）限制缓存规模。
- `guardrailRetries`（默认 `1`）：一轮被 Quick 服务端审核拦下（回复里只有一句固定文案、usage 为 0）时，插件在客户端看到之前自动在同一 thread 上重试几次；`0` 关闭，直接把拦截交给客户端。
- `callRetries`（默认 `1`）：模型输出的 `<invoke>` 块没写完或 `<parameter>` 不合法时，先在同一 thread 上要求它重发（必要时拆小）；只有在它仍然失败时才把占位调用 `aws_quick_invalid_tool_call` 交给客户端。客户端已经在上一轮看到了正文或有效工具调用时不再重试，避免重复。
- `answerRetries`（默认 `0`）：一轮正常结束、但只输出了推理、正文和工具调用都为空（Claude Code 里表现为 “Thought for Ns” 后什么都不写）时，默认直接以 502 报错，而不是再花几分钟重试——重试解决不了模型不收敛的问题。设为 `1` 才会在同一 thread 上再要求模型直接回答，并把思考强度降一档。例外：如果刚发生过一次审核重试，空回答会再多要一次（即使为 `0`），因为这正是用户通常会手动输入的 continue。
- `thinkingEffortCap`（默认 `high`，对齐旧桥）：给客户端的思考强度设上限。你设 `medium` 就发 `medium`，设 `high` 就发 `high`，只有 `max` 会被压成 `high`；`'max'` 可关闭封顶，`'medium'` 更快。
- `contextWindow`（默认 `1000000`，即 Quick 自己报的值）：可选的客户端上下文上限。调低会让 Claude Code 更早 compaction；对读文件的 agent 通常不划算。

**为什么默认压掉 max？** 实测（Claude Code + `smart`，`max` 强度，368 轮）：输出 token 中位数 2442、P90 约 2.6 万、最大 63322（正好贴着 64k 输出上限）；单轮耗时中位数 34 秒、P90 4 分 47 秒、最长 21 分 49 秒。旧桥从来不把 `max` 发给 Quick：它在网关层就把 `max/xhigh` 映射成 `high`。这是它“慢但能用”的主要原因之一。

**64KB 单帧与工具结果。** 一个 17k token 的 Read 结果约 68KB，本身就超过一帧；插件要么截断（模型会重跑同一个调用），要么上传成附件（模型要多花一个服务端步骤去读）。当一帧放不下、需要截断 8KB 以上的工具结果时，完整内容会先上传成附件，帧里保留头尾预览和指向文件的说明；更小的结果带一个标记，说明重复同一个调用只会得到同样的截断，只有缩小范围（offset/limit）才能拿回中间部分。工具说明里也会告诉模型：更早的工具结果可能被截断，需要时重新调用，不要凭记忆猜。

## 常见问题

**登录第二个账号后，第一个账号失效了。**
多半是在同一个浏览器里先退出了第一个账号，再登录第二个。退出登录会吊销第一个账号的凭证，插件就无法再刷新它。
请换一个浏览器，或者用无痕窗口登录另一个账号，不要在浏览器里退出已经添加的账号。

## 已知限制

- **总期限只覆盖单次调用，不覆盖网关整条重试链。** Magpie 可以再次调用插件或
  换账号，各次调用分别计时。取消只中断当前调用的等待，不会停止其他调用仍需的
  共享认证刷新或建连。JavaScript 定时器不能抢占同步工作：本地 agent 冷启动
  的 ZIP 解压使用同步子进程，有独立的 10 分钟上限；控制权返回后才检查已到期
  的 scope。因此事件循环阻塞时不能保证严格墙钟上限，但过期调用不能继续生成
  或提交可复用线程。预算约束提供方的工作，直到生成流实际结束；不包含提供方
  已完成后，慢客户端仍在等待的下游网络发送。

- **用量超限转为 429，并快速故障转移。** Quick 同时执行滚动 session
  桶（每个时间窗内的代理运行分钟数）和月度桶。账号用尽时，运行时有时
  不报错，而是返回一条完整内容只有"You've reached your usage limit…"
  的普通助手消息——插件会识别这种伪 200（仅整句精确匹配，引用该句的
  正常回复不受影响），转成 `rate_limit_error`/429。随后查询该账号
  `profile/usage` 里 session 桶的 `resume_in_minutes`，在窗口恢复前
  直接快速返回 429，不再每次白烧一轮上游请求，magpie 会立即切到
  其他账号。
- **工具调用是文本约定模拟**：Quick 的 agent 在服务端自带工具链（浏览器、本地文件、MCP 等），
  `tool_start`/`tool_result` 等事件由它自己执行、客户端只观测，`message_complete.tool_calls`
  恒为空。客户端传入的 OpenAI `tools` 通过提示词注入为 Anthropic 风格的
  `<function_calls><invoke><parameter>` XML 约定，由插件解析成标准 `tool_calls`
  返回；`tool` 角色的结果渲染为 `<tool_result …>` 块续接同一 thread。完整的工具说明走 `custom_prompt`
  （和旧桥一样，不进 Quick 的对话历史），只在 fresh thread 或新增工具时发；
  每条 user message 末尾附一段简短提醒。可靠性取决于模型遵守约定——已实测
  `tool_choice:'required'` 下 smart/advanced 均能稳定产出；模型偶尔会先用
  自带工具（如联网搜索）直接作答，此时表现为普通文本回复。若模型改用
  Quick 自己的原生工具通道调用了客户端声明的工具，插件会识别该调用并按
  普通 `tool_calls` 返回，并在 Quick 把它重写成文本之前中止本轮。
  Quick 自带工具的执行结果不会映射为 OpenAI `tool_calls`（那是它内部过程）。
- **图片：小图内联，大图走云端上传**：能放进消息帧的内联图片（`data:` URL、
  Anthropic base64 块、工具结果里的图片）仍作为 `user_message.attachments`
  的 base64 发出；更大的图（每张 ≤3MiB、每轮最多 4 张、合计 ≤5MiB、仅限
  内联数据）会通过 Quick 自己的附件上传流程传到账号的云端会话工作区——
  和 Quick 应用里附加文件是同一个位置。远程 URL 和非图片文件
  （`file`/`input_file`）仍不支持；上传失败时会在消息里注明图片缺失。
  云端上传在直连会话（OAuth / 凭据管理器登录）和本地 outpost 回退路径上
  都可用：outpost 的 `sncs-session` 同样提供上传所需的 `id_token` /
  `ws_host`（已实测）。
- **采样参数**：`temperature` 等不在协议内，传了也会被服务端忽略（`capabilities.temperature:false`）。
- **会话与账号绑定**：只有账号身份和网关会话键都相同时才会续接 thread；换号后旧 thread 自动失效重建。
- **多窗口/并发**：同一 QuickSocket 上不同 thread 可并行 turn。同一会话的请求会短暂等待上一轮的缓存提交或取消清理（有上限）。如果上一轮在发送后取消，下一次请求会新建 thread，不再复用旧前缀；如果两个请求仍同时落到一个 thread 上，第二个会被拒绝（`busy`）。
- **消息体积**：整个 `user_message` 帧服务端上限 64KB（`text` 与
  指令及附件共享）。超大 system prompt / 工具 schema / 会话历史会自动
  压缩（schema 去注解、工具规格 lite→仅名字降级、tool_result 封顶）。整段对话装不进
  一帧时，插件把整段对话（包括原始工具输出和当前请求）无损上传成
  `context_*.txt` 附件；拿到实际附件元数据后再精确计算帧预算。
  当前帧优先保留最新用户请求，有余量时再放最多 4KB 的近期 user/assistant
  原文摘录，标注来源，只作为续接线索，不冒充生成的摘要或已核实事实；工具日志
  和调用参数不放进摘录。模型仅在缺少具体信息时按需查附件，不再先通读全文。
  最新请求能放下就完整内联，确实放不下时才提供明确标注的头尾预览，完整原文
  仍在附件中；最后一条是工具结果时，有余量就提供有界预览。已单独上传的工具输出在
  transcript 中保留文件指针，不重复上传正文；复用 thread 时不重复注入摘录。
  附件传不上去时，请求以 400 `context_length_exceeded` 失败，让客户端压缩自己的
  历史，而不是静默截断（静默截断会让模型反复重读、忘记任务）。设
  `contextAttachments:false` 可关闭这一行为（同样保留响亮的 400）。
  普通对话的系统指令与本轮消息编码后若能放进同一帧，就会完整发送。
  Claude Code 的 Auto 权限审核会保留完整策略：策略超过单帧上限时，会原样预热进
  一个专用 Quick 线程（按策略哈希缓存、定期轮换），分类器仍能看到每一条规则；
  只有超过约 400 KB 的策略或实在放不下的请求才返回 HTTP 413。策略变化后的第一次
  审核要多花几秒预热，之后和普通一轮一样快。
- **OAuth 登录仅限 consumer/social 通道**：重放的是桌面端 `quick.aws.com/sn`
  的 `social` provider 流程。走企业 IdP 的租户如果 issuer 不是 Amazon 社交 IdP
  可能无法完成——这种情况请改用本地凭据方式。OAuth 路径会发送固定的生成设备 ID，
  但不运行本地 agent，需要已连接设备的服务端能力（本机文件、应用）不适用于此路径。

## 安全与凭据

- instance token 是插件每次启动随机生成的，**只**通过 stdin 交给子进程，不落盘、不进日志。
- 本地凭据路径下 `id_token`/`ws_host` 等只在内存中流转；会话缓存持久化到
  `thread-sessions.json`，里面是账号身份、网关会话键、消息 key 哈希、thread id
  和工具名，没有消息内容；插件重载后仍可续接 thread。
- OAuth 路径会把 `{type:'oauth', tokens:{access_token, refresh_token, id_token, expires_at}, client:{client_id, client_secret, …}, tenant_url, ws_host, …}` 存入
  `oauth-sessions.json`（0600）——这是 refresh token 轮换的必然要求，
  与 Quick 桌面端自身在系统凭据存储里保存登录态等价；请保护好自己的用户目录。
- 本地凭据（Credential Manager）路径只**读取**应用已存的会话；续期时把
  新 token **写回同一个凭据**（含 `session@` 孪生项），保证桌面端读到的
  始终是有效 token——等价于应用自己刷新，只是提前帮它做了。
- outpost 的 `/auth/*` 全部要求 `Authorization: Bearer <instance token>`；
  `/health` 是唯一公开端点。
- 插件不会修改 Amazon Quick 的任何文件；`agent.zip` 解压到系统临时目录
  （`<tmp>/magpie-aws-quick/agent/<size>-<mtime>/`），可用 `cacheDir` 选项改位置。

## 开发

```bash
npm test          # node --test test/*.test.mjs（fake WS server，无需真账号）
npm run typecheck # tsc --noEmit，然后 tsconfig.strict.json
```

协议细节见 [PROTOCOL.zh-CN.md](PROTOCOL.zh-CN.md)。测试直接 import TypeScript
源码，需要 Node 的类型擦除（22.18+）。

## 鸣谢

本插件的重构来自
**[magpie-AWS-Quick-bridge](https://github.com/DaBinBinah/magpie-AWS-Quick-bridge)**
（作者 [DaBinBinah](https://github.com/DaBinBinah)，npm 包
`magpie-aws-quick-bridge`）：按「账号 + 会话键 + 消息前缀」判定 thread 的复用
模型、把工具说明放进 `custom_prompt` 并在每条 user message 后附提醒的
`<invoke>/<parameter>` 约定、简短的提示词框架、默认把 `max` 压到 `high`、
默认 incognito（`keep_sessions`）以及超长上下文的附件处理，都是照它移植的。
在这个 fork 出现之前，它就已经让 Quick 能在 Claude Code 里干活；本仓库对协议
细节的理解也有很大一部分来自它的文档和实现。谢谢作者。

该项目采用 GPL-3.0；从中移植的部分沿用同一许可，本仓库因此整体采用
GPL-3.0。

## 许可

GPL-3.0。Amazon Quick 是 AWS 的产品，本插件与 Amazon/AWS 无隶属关系。

## 社区

有问题、bug 报告、建议，或想一起折腾？Issue 和 PR 非常欢迎——
**[linux.do](https://linux.do)** 是找我和这个插件社区的最佳入口。
