[English](README.md) | [中文](README.zh-CN.md)

# magpie-aws-quick — Use your own Amazon Quick (AWS Quick) account in magpie

Turns **your own** Amazon Quick sign-in (browser OAuth or desktop login) into a [magpie](https://github.com/yetone/magpie)
provider (`aws-quick`), so agents routed through magpie — Claude Code, Codex,
Gemini CLI, OpenCode, etc. — can use the models behind Quick
(see `magpie models | grep aws-quick`).

> **Recommended clients: Claude Code or pi (pi-agent).** The plugin is
> developed against these two. In Claude Code, tool calls, thread reuse
> across turns, interrupts and large file writes are tested end-to-end; pi's
> session-affinity headers are used to keep reusing the same Quick thread.
> Other clients work too, but get less testing.

> **Prefer the native Quick desktop app?** [aws-quick-manager](https://github.com/httpdone/aws-quick-manager)
> switches accounts in the official Quick app in one click and copies chat
> sessions between accounts through Quick's cloud API, with no reverse proxy.

> ⚠️ For personal use with your own account only. This drives the desktop
> client's internal bidirectional WebSocket protocol (not a public API) and
> very likely violates AWS terms of service; your account may be limited or
> banned. Use at your own risk.

## How it works

magpie has a real plugin mechanism: it loads **OpenCode provider plugins** in
Bun. This project is exactly such a plugin:

```
Agent ──(Anthropic / Responses / Chat / Gemini)──▶ magpie gateway 127.0.0.1:3425
      ──(OpenAI Chat Completions)──▶ this plugin's fetch ──▶ wss://<qbs-cell>/streaming/quickwork-chat-bidirectional-stream
```

The key point: **no packet capture, no proxy, no app patching**. The Amazon
Quick desktop app already bundles a Python backend (`quickwork-agent`, packed
in `resources/agent.zip`). Run standalone with `--outpost-only`, it exposes
local endpoints — `/health`, `/auth/status`, `/auth/sncs-session`,
`/local/outpost-id` — on `127.0.0.1:<port>`, and it can read the login state
the desktop app stores in the system credential store.

What the plugin does:

1. **Finds and starts the outpost**: prefers the `quickwork-agent` the app
   already extracted into userData; otherwise extracts `resources/agent.zip`
   to a temp dir and runs it. It hands the child a **self-generated instance
   token** over stdin (the same contract as the Electron main process's
   `AgentBridge`), then waits for `/health`.
2. **Gets a session**: `GET /auth/sncs-session` returns
   `{id_token, ws_host, actor_arn, …}`; `GET /local/outpost-id` returns the
   device id. Cached until `usable_until`, refreshed automatically.
3. **Connects the chat WS**:
   `wss://<ws_host>/streaming/quickwork-chat-bidirectional-stream`
   (query: `surfaceType`/`token`/`outpostId`/`workingSessionId`/`channel`),
   sends `session_connect` (waits for `session_established`/`connected`),
   then `user_message`. Uplink frames are binary
   `{"eventType":"rawInputEvent","payload":{"payload":base64(inner JSON)}}`;
   downlink frames are AWS event-stream messages (`:event-type=rawOutputEvent`,
   body likewise base64-wrapped inner JSON). A `ping` goes out every 25s.
4. **Protocol translation**: OpenAI `messages` are rendered into Quick's
   `text` (below) — except the system prompt, which rides the dedicated
   `user_message.custom_prompt` field (verified live); downlink
   `text_delta`/`thinking_delta`/`turn_usage`/`message_complete` become
   OpenAI `content`/`reasoning_content`/`usage`. A user turn ends at
   `message_complete` with `continuation_expected !== true` — the same
   rule the desktop renderer uses.
5. **Thread reuse (on by default)**: the account, the gateway session key and
   the message-key prefix decide whether a request continues a thread — see
   [Thread reuse](#thread-reuse) below.

Device ids: the desktop app always sends its profile's `device_id` as `outpostId`, so direct sessions send a stable per-account one too instead of an empty value. Credential Manager sign-ins reuse the desktop profile's own `device_id` (read-only); OAuth accounts get a UUID generated once at sign-in and stored on the account record, kept across token refreshes and re-logins. The same id goes into oversized-image delivery. Accounts never share an id, and an id is never rotated. `stableDeviceId: false` goes back to the empty value. The local-outpost backend uses whatever id Quick's own agent reports; the agent inherits `QUICKWORK_BASE` / `QUICKWORK_ROOT` from the environment.

### Thread reuse

Quick keeps conversation history server-side per `thread_id`, but OpenAI
clients resend the entire transcript on every request. The plugin makes one
decision:

- **A thread is a message-key prefix** — each user/tool message contributes a
  hash of its role, tool-call id, tool name and normalized text; an assistant
  message is the single wildcard `assistant`. The client re-sending its own
  rendering of our reply (trimming, notes, regenerated ids, dropped thinking)
  therefore still matches. A hit sends only the new user/tool tail upstream;
  Quick's server-side history supplies the rest.
- **Changed history starts a new thread** — an edited, rewound or
  compacted user/tool message changes its key, so the stored prefix stops
  matching and the plugin starts a fresh thread with the transcript it now has.
  Continuing the old thread is how a model ends up working from a 500k-token
  history the client already compacted. A request whose new tail contains an
  assistant message does not match either: the client holds more history than
  the stored thread describes.
- **Identity is account + gateway session key + message prefix** — the system
  prompt, agent mode, tool list and thinking effort are not part of it. Claude
  Code changes its own system prompt mid-session (memory, billing, ToolSearch)
  or switches model tier; that must not discard the thread.
- **Background forks and subagents are separate** — the known Claude Code
  suggestion, away-summary and title requests use one-shot Quick threads and
  never take or commit the shared conversation cache or wait on its turn lane.
  Ordinary `x-magpie-subagent` branches retain multi-turn reuse in their own
  partition. Known `query_source`/`querySource` request metadata or an explicit
  `x-magpie-query-source` adapter header take precedence; the header is an
  adapter convention, not something every gateway is known to send. Without
  metadata, only the current, strict Claude prompt signatures are recognized;
  short text, missing tools and historical quotations are not enough. Changed
  client prompts may require a classifier update or explicit metadata.
- **A match is single-use** — taking an entry removes it from the store. A
  preparation failure before sending restores it; once `user_message` may
  have been sent, cancellation, timeout or an uncertain failure invalidates
  the old prefix. The next request safely starts a new thread. Quick's
  `stop_generation` is best effort, not a rollback of server history.
- **Bounded memory** — entries expire after 24h idle and the store is
  LRU-capped at 200 threads. The cache persists to `thread-sessions.json`
  (account identity, session key, message-key hashes, thread ids and tool
  names — no message content), so reuse survives plugin reloads.

This is much simpler than the old three-tier matcher (hash chain + fuzzy
anchors + session-key fallback) and removes both the cross-chat session-key
collision and the "resume a stale thread after compaction" behavior. The
trade-off: after client compaction the old server-side context is gone and the
model rebuilds state from the compacted history — exactly what
`magpie-aws-quick-bridge` did, and why its context never grew to 500k.

### Models: agent_mode, not model ids

Quick's `user_message` selects a tier via `agent_mode`; the server routes to a
concrete model (`resolved_model_id`/`served_model_id` in `turn_usage`):

| magpie model id | agent_mode | observed resolved_model_id (example) |
|---|---|---|
| `fast` | fast | `us.anthropic.claude-haiku-5-5` |
| `balanced` | balanced | (server-routed) |
| `smart` | smart | `us.anthropic.claude-opus-5-5` |
| `advanced` | advanced | (may normalize to smart) |

The `X-Magpie-Effort` header (or body's `reasoning_effort`/`thinking_effort`)
maps to `thinking_effort`: `off/low/medium/high/max`. `max` is capped to
`high` by default (`thinkingEffortCap`); set the cap to `max` to pass it
through.

## Install

### 1. Requirements

- **magpie** (the OpenCode plugin host).
- **One of two sign-in paths** (pick at `magpie login`):
  - **Browser OAuth** — nothing else needed. The plugin replays the app's own
    OIDC+PKCE login in your browser and chats on the stored token directly.
    Works on machines without the desktop app, and without administrator rights.
  - **Local credentials** — the Amazon Quick **desktop app** installed and
    **signed in** (`%LOCALAPPDATA%\Programs\quickwork\` on Windows — i.e.
    `C:\Users\<you>\AppData\Local\Programs\quickwork\`; `/Applications/Amazon Quick.app`
    on macOS). On Windows the plugin reads the app's stored session directly
    from Credential Manager — **no agent.exe, no outpost** while the token is
    fresh; expiry is covered by OIDC refresh with write-back so the desktop
    app keeps working. On other platforms (or if the read fails) it falls
    back to spawning the bundled `quickwork-agent --outpost-only`, which
    reuses the app's login state — **the desktop app does not need to stay
    running**; the session lives in the OS credential store.
- **Node ≥ 22.18**: needed for tests and `bin/serve.mjs`, which import the
  TypeScript sources directly (unflagged type stripping starts at 22.18). The
  plugin itself is loaded by magpie's Bun host and has zero runtime
  dependencies; `typescript` and `@types/node` are dev-only.

### 2. Install the plugin

```bash
magpie plugin add magpie-aws-quick   # from npm; or a local directory / git URL
magpie login aws-quick              # pick a sign-in method when prompted
```

In the magpie app, search "Amazon Quick" under **Plugins** and install it from
there.

**Alternative: standalone OpenAI-compatible proxy** — `node bin/serve.mjs`
serves the same adapter on `127.0.0.1:$PORT/v1` (default port 3426) for
clients that don't go through magpie, or to add Quick as a custom magpie
provider via `magpie provider add --base-url http://127.0.0.1:3426/v1`.
See the file header for options (`PROXY_TOKEN` auth recommended).
`QUICK_REQUEST_TIMEOUT_MS` sets the same fixed request budget (`0` disables);
`QUICK_MAX_TURN_ATTEMPTS` sets the shared generation-attempt cap. The proxy
also reads session, subagent, effort and explicit query-source adapter headers
using the same rules as the plugin.

**Sign-in methods**

- **账号登录（Browser OAuth）**: opens `quick.aws.com/sn`, waits on a localhost
  callback, performs client registration + code exchange itself, then stores
  a unified record `{ tokens: { access_token, refresh_token, id_token, expires_at }, client: { client_id, client_secret, … }, tenant_url, ws_host, actor_arn, … }` in
  `%APPDATA%\magpie-aws-quick\oauth-sessions.json` (Windows) /
  `~/.config/magpie-aws-quick/` (Linux) /
  `~/Library/Application Support/magpie-aws-quick/` (macOS), mode `0600`.
  The ~1-hour id_token is auto-refreshed via the stored refresh token
  (rotation persisted). No outpost is spawned at request time — the chat
  WebSocket goes straight to the tenant's `ws_host`.
- **复制登录地址（Copy sign-in link）**: the same browser OAuth flow, but
  magpie opens nothing — copy the link into the browser you sign in to
  Amazon with, then paste the address-bar URL into the box magpie shows.
  On another computer the browser can't reach the `127.0.0.1` callback: the
  first paste saves the account info and asks you to start again — the
  second paste finishes the login (saved info valid for 15 minutes).
- **本地凭据（Local credentials）**: on Windows reads the app's session from
  Credential Manager and chats directly (OIDC auto-refresh, write-back keeps
  the app's tokens valid); elsewhere or on failure it boots the bundled
  outpost and calls `/auth/sncs-session` — a clear error tells you to sign in
  to the app first if it isn't.

### Usage on the account card

The plugin implements magpie's `auth.usage` hook, so the account card and the
**Usage** page show the account's Quick quota: agent hours used of the plan's
allowance, the plan name (e.g. *Quick Lite (free trial)*) and the trial's
expiry. It reads `getAvailableEntitlementUnits` from the tenant data plane
with the account's own token — the same numbers as the desktop app's usage
widget, which also assumes the allowance resets on the 1st of next month.

### Options

A few plugin options tune request handling (`magpie plugin options aws-quick '{…}'`):

- `headerWaitMs` (default `10000`): streaming requests return response headers
  after Quick's first output **or** this long, whichever comes first — Quick
  can sit silent while its own tools run, and gateways cap how long they wait
  for headers. `0` waits for the first output as before.
- `requestTimeoutMs` (default `600000`, 10 minutes): fixed total budget for
  one plugin/proxy call, starting before body parsing and backend/identity
  preparation and covering uploads, review, connection waits, generation and
  internal retries. Progress does not reset it. `0` explicitly disables it.
  Before SSE headers, expiry is HTTP 503; afterwards it is an SSE error with
  code 503 followed by `[DONE]`. Client cancellation is distinct: 499.
- `idleTimeoutMs` (default `300000`): abort a generation turn with no Quick
  progress (keepalives don't count) for this long, with a 503 `timeout`.
  This is separate from the fixed request deadline. `0` disables only this
  watchdog. Cancellation/timeout after sending triggers best-effort
  `stop_generation` for that thread, without closing the shared socket.
- `maxTurnAttempts` (default `3`, minimum `1`): shared generation-attempt cap
  across guardrail, malformed-call, empty-answer and fresh-thread retries.
  Raising an individual retry option below cannot exceed this cap or the
  request deadline.
- `showQuickTools` (default `true`): surface Quick's built-in tool activity
  (`tool_start`) as `[Quick: <name>]` reasoning lines so long agentic turns
  don't look dead; `false` hides them.
- `stableDeviceId` (default `true`): direct sessions send a stable
  per-account device id as `outpostId` (see Device ids above); `false` sends
  an empty value.
- `keepSessions` (default `false`): when true, chats are listed in Amazon Quick
  (its chat list and memory); the default keeps every chat incognito.
  `keep_sessions` is accepted too, for the old bridge's settings file.
- `sessionReuse` (default `true`): continue Quick threads across turns; `false`
  sends every request on a fresh thread. `sessionTtlMs` (default 24h) and
  `sessionMax` (default 200) bound the cache.
- `guardrailRetries` (default `1`): when Quick's server-side content check stops a turn (a canned sentence with usage 0/0), the plugin retries it on the same thread before the client ever sees the block; `0` disables, surfacing the block.
- `callRetries` (default `1`): when an `<invoke>` block is incomplete or a `<parameter>` is malformed, ask the model to resend it on the same thread first (split large content if needed). Only if that fails does the placeholder `aws_quick_invalid_tool_call` reach the client. It does not retry when prose or valid calls were already streamed, to avoid duplicates.
- `answerRetries` (default `0`): a turn can finish normally with reasoning but no text and no tool call. Claude Code shows "Thought for Ns" and then an empty assistant message, so the task stalls. The default is a loud 502 — retrying only buys another multi-minute silence. Set it to `1` to ask again on the same thread ("answer now", one effort level lower). One coupled exception: if a guardrail retry just ran, an empty result asks once more even at `0`, because the manual "continue" would be exactly that request.
- `thinkingEffortCap` (default `high`, matching the old bridge): ceiling for a requested thinking effort. `medium`/`high` pass through; only `max` becomes `high`. `'max'` disables the ceiling, `'medium'` is faster.
- `contextWindow` (default `1000000`, Quick's own value): optional cap on the client's context window. Lowering it makes Claude Code compact earlier, which is usually a bad trade for a file-reading agent.

**Why max is capped by default.** Across 368 measured `max` turns the median output was 2,442 tokens, p90 ~26k and the maximum 63,322 (right at the 64k cap); median turn time was 34 s, p90 4m47s, max 21m49s. The old bridge never sent `max`: it mapped `max/xhigh` to `high` in its gateway. That is a large part of why it was slower but usable.

**64 KB frames and tool results.** One 17k-token Read result is ~68 KB — larger than a whole frame. The plugin must either cut it (the model re-runs the same read) or upload it (the model spends a server-side step reading it back). When the frame has to cut a tool result of 8 KB or more, the full text is uploaded and the frame keeps a head/tail preview pointing at the file; a shorter cut gets a marker saying that repeating the same call returns the same cut, and that only a narrower range (offset/limit) recovers the middle. The tool preamble also tells the model that earlier results may be truncated and to call again rather than guess from memory.

## FAQ

**After signing in to a second account, the first one stopped working.**
You most likely signed out of the first account in the same browser before
signing in to the second. Signing out revokes that account's credentials, so
the plugin can no longer refresh it. Sign in each account in a different
browser or in a private/incognito window, without signing out of the others.

## Known limitations

- **The deadline covers one invocation, not the gateway's whole retry chain.**
  Magpie can invoke the plugin again or switch accounts; those calls have
  separate budgets. Request cancellation interrupts this caller's wait, not
  shared authentication refresh or connection work needed by other callers.
  JavaScript timers cannot preempt synchronous work: cold local-agent ZIP
  extraction uses a synchronous child process with its own 10-minute limit;
  the expired scope is checked when control returns. A blocked event loop is
  therefore not a strict wall-clock guarantee. No expired caller is allowed
  to proceed to generation or commit a reusable thread. The budget bounds
  provider work through generation-stream settlement, not a slow client's
  final network drain after the provider has finished.

- **Usage limits become 429s, with fast failover.** Quick enforces a rolling
  session bucket (minutes of agent time per window) plus a monthly bucket.
  When an account runs out, the runtime sometimes answers with a NORMAL
  assistant message whose whole text is "You've reached your usage
  limit…" instead of an error — the plugin detects that pseudo-200 (exact
  match only, so replies quoting the sentence pass through) and turns it
  into a `rate_limit_error`/429. It then queries the account's
  `profile/usage` for the session bucket's `resume_in_minutes` and fails
  fast with 429 until the window resumes, so magpie moves to another
  account immediately instead of burning one upstream turn per request.
- **Tool calls are a text-convention simulation**: Quick's agent owns a
  server-side toolchain (browser, local files, MCP, …); its `tool_start`/
  `tool_result` events are executed by Quick itself while clients only observe,
  and `message_complete.tool_calls` is always empty. OpenAI `tools` sent by
  the client are injected as an Anthropic-style `<invoke>/<parameter>` XML
  convention and parsed back into standard `tool_calls`; `tool`-role results
  render as `<tool_result …>` blocks continuing the same thread. The full tool spec is sent
  on a fresh thread and for tools added later; other turns on a reused thread
  carry only a short reminder, because everything in the message stays in
  Quick's thread history and counts toward the context. Reliability depends
  on the model honoring the convention — verified stable under
  `tool_choice:'required'` for smart/advanced; occasionally the model answers
  directly with its own tools (e.g. web search) instead, which shows up as a
  plain-text reply. If the model instead invokes a client-declared tool
  through Quick's own native tool channel, the plugin recognizes the call and
  emits it as a normal `tool_calls` item, stopping the turn before Quick can
  rewrite it as text. Quick's built-in tool results are never mapped to OpenAI
  `tool_calls` (that's its internal process).
- **Images: small ones inline, larger ones uploaded.** Inline images (`data:`
  URLs, Anthropic base64 blocks, images inside tool results) that fit the
  frame go as `user_message.attachments` base64; bigger ones (up to 3 MiB
  each, 4 per turn, 5 MiB total, inline data only) are uploaded through
  Quick's own attachment flow and land in the account's cloud session
  workspace — the same place the Quick app puts them. Remote URLs and
  non-image files (`file`/`input_file` parts) are still unsupported; a
  failed upload falls back to a note telling the model the image is
  missing. Cloud upload works on direct sessions (OAuth / Credential Manager
  sign-in) and on the local-outpost fallback: outpost sessions carry the same
  `id_token` / `ws_host`, which is all the upload flow needs (verified live).
- **Sampling params**: `temperature` etc. don't exist in the protocol and are
  ignored server-side (`capabilities.temperature:false`).
- **Sessions are account-bound**: a thread is only continued for the same
  account identity and gateway session key; switching accounts transparently
  invalidates old threads.
- **Concurrency**: different threads can run turns in parallel on one
  QuickSocket. Requests for the same conversation wait briefly for the previous
  turn's cache commit or cancellation cleanup. If that turn was cancelled after
  sending, the next request starts fresh rather than reusing its old prefix. If
  two requests still reach one thread at once, the second is rejected (`busy`).
- **OAuth sign-in is consumer/social only**: it replays the desktop app's
  `quick.aws.com/sn` flow (`social` provider). Enterprise-IdP tenants whose
  issuer is not the Amazon social IdP may not complete this flow — use the
  local-credentials method on a machine with the app installed instead. The
  OAuth path sends a stable generated device id but runs no local agent, so
  any server feature that needs a connected device (local files/apps) won't
  apply.
- **Message size**: the whole `user_message` frame is hard-capped at 64 KB
  server-side (text, instructions and attachments share it). Oversized system prompts /
  tool schemas are compacted automatically (schema de-annotation, tool-spec
  lite then names-only fallback, capped tool results). A fresh thread whose
  whole transcript cannot fit one frame does not lose its middle: the
  full conversation goes up as a lossless `context_*.txt` attachment through
  Quick's own upload flow, including original tool output and the current
  request. After actual attachment metadata is counted, the frame keeps the
  latest user request and, when room remains, up to 4 KB of quoted earlier user/assistant
  messages as navigation hints—not a generated or verified summary. Tool logs
  and call arguments are not copied into those hints. The archive is consulted
  only for missing information, not read in full before continuing. The latest
  request stays whole inline when it fits; otherwise its full text stays in the
  archive alongside an explicitly marked head/tail preview. A final tool result
  gets a bounded preview when room permits. Already uploaded tool output keeps
  its file reference rather than being uploaded again inside the transcript.
  Reused threads do not receive the hints again. If the upload fails, the
  request errors with 400
  `context_length_exceeded` so the client compacts its own history instead of
  working from a silently gutted transcript (`contextAttachments:false` disables
  the upload and keeps the loud 400). Ordinary chat keeps full system instructions when they fit alongside the
  encoded turn. Claude Code Auto permission reviews keep the complete policy:
  a policy too large for one frame is primed verbatim into a dedicated Quick
  thread (cached per policy, rotated periodically), so the classifier still
  sees every rule; only a policy beyond ~400 KB or an un-fittable request
  returns HTTP 413. The first review after a policy change pays a few seconds
  of priming; later ones are as fast as a normal turn.

## Security & credentials

- The instance token is randomly generated per launch and passed to the child
  **only** via stdin — never written to disk or logs.
- On the local-credentials path, `id_token`/`ws_host` etc. live only in memory;
  session-cache entries persist to `thread-sessions.json` and hold the account
  identity, the gateway session key, message-key hashes, thread ids and tool
  names — no message content — so thread reuse survives plugin reloads.
- On the OAuth path, `{type:'oauth', tokens:{access_token, refresh_token, id_token, expires_at}, client:{client_id, client_secret, …}, tenant_url, ws_host, …}` is persisted in
  `oauth-sessions.json` (mode `0600`) — unavoidable for refresh-token
  rotation, equivalent to the desktop app keeping its sign-in in the OS
  credential store. Protect your user profile accordingly.
- The Credential-Manager path only **reads** the session the app already
  stored; on refresh it **writes the new tokens back to the same credential**
  (including the `session@` twin) so the desktop app always sees valid
  tokens — equivalent to the app refreshing early on our behalf.
- Every outpost `/auth/*` endpoint requires
  `Authorization: Bearer <instance token>`; `/health` is the only public one.
- The plugin never modifies any Amazon Quick files; `agent.zip` is extracted
  to a temp dir (`<tmp>/magpie-aws-quick/agent/<size>-<mtime>/`), overridable
  via the `cacheDir` option.

## Development

```bash
npm test          # node --test test/*.test.mjs (fake WS server, no real account)
npm run typecheck # tsc --noEmit, then tsconfig.strict.json
```

Protocol details in [PROTOCOL.md](PROTOCOL.md). The tests import the
TypeScript sources directly, so Node's type stripping must be available
(22.18+).

## Credits

The rework in this plugin follows
**[magpie-AWS-Quick-bridge](https://github.com/DaBinBinah/magpie-AWS-Quick-bridge)**
by [DaBinBinah](https://github.com/DaBinBinah) (npm:
`magpie-aws-quick-bridge`). The account + session-key + message-prefix thread
matcher, the `<invoke>/<parameter>` tool convention with the spec in
`custom_prompt` and a reminder after each user message, the short prompt
framing, the `high` thinking-effort cap, the incognito default
(`keep_sessions`) and the context-attachment handling are all ported from it.
It made Quick usable with Claude Code long before this fork existed, and its
protocol notes are why the reverse-engineered parts here are understood at
all. Thank you.

That project is GPL-3.0; the parts ported from it keep that license, and
this repository is GPL-3.0 for that reason.

## License

GPL-3.0. Amazon Quick is an AWS product; this plugin is not affiliated with
Amazon/AWS.

## Community

Questions, bug reports, suggestions, or want to tinker together? Issues and
pull requests are very welcome — **[linux.do](https://linux.do)** is the
best place to find me and the community around this plugin.
