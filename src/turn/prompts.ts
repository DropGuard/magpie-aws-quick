// Client-facing prompt add-ons and the note that explains trimming.
//
// These strings are part of the wire contract (they ride custom_prompt and the
// assistant message), so they live in one neutral module: the planner writes
// them, the stream interpreter uses the placeholder tool name, the handler
// re-exports them for tests. Keeping them here avoids consume -> plan.
import type { RenderStats } from '../translate.ts'

// Quick's own system prompt asks for Quick-app UI markup (decision cards,
// artifacts). External clients render plain text/Markdown, so that markup
// leaks as raw tags. Scoped so code/file output (e.g. HTML <option>) is unaffected.
export const PLAIN_TEXT_NOTE = 'Reply formatting: don\'t emit AWS Quick UI tags (such as <decision>, <option> or a sources block) — this client shows them as raw text; when the user needs to choose, ask with a short numbered list. This only affects how replies are formatted, not code or file contents.'
// With client tools, a formatting note alone reads as "put files in the chat":
// verified live, the model then pasted the code instead of calling Write.
export const TOOLS_STILL_APPLY = 'When the user asks you to make or change something (a page, script, file or project), do it on the user\'s machine with the client tools — write the file rather than pasting its contents into the reply.'
// Placeholder tool name handed to the client when a <tool_call> can't be
// parsed (see consume in handler.ts): no client has it, so nothing runs.
export const INVALID_CALL_TOOL = 'aws_quick_invalid_tool_call'

/**
 * What to tell the client about this turn's trimming, by reason. A squeezed
 * <system-reminder> alone stays silent: Claude Code sends the same content as
 * the system prompt, so it is hygiene, not a loss — and the old blanket
 * "context over 64KB" line sent people hunting for a size problem that was
 * not there.
 */
export function cutNote(stats: RenderStats | null | undefined, clippedSystem: boolean) {
  const cut = stats?.cut || {}
  const parts: string[] = []
  if (cut.system || clippedSystem) parts.push('调用方的系统指令过长，已截短（规则可能不完整）')
  if (cut.preamble) {
    const tier = stats?.specTier || ''
    parts.push(tier === 'lite'
      ? '工具说明过长，已省略参数结构、只留名称与描述（参数需按用途推断）'
      : tier === 'names'
        ? '工具说明过长，已只保留工具名'
        : '工具说明过长，已缩短各工具的描述（参数结构保留）')
  }
  if (cut.history) parts.push(`有 ${cut.history} 条较早消息装不进一帧，已丢弃`)
  if (cut.tool) parts.push(`${cut.tool} 处工具结果过大，已保留头尾、省略中间（需要更多内容就在原工具上缩小范围重跑）`)
  if (cut.turn) parts.push('当前消息过长，已保留开头和结尾')
  if (cut.frame) parts.push('整帧装不下，已截短末尾')
  if (!parts.length) return ''
  return `Quick 单帧上限 64KB，这一轮做了取舍：${parts.join('；')}。`
}
