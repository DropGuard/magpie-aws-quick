// Client-facing prompt add-ons and the note that explains trimming.
//
// These strings are part of the wire contract (they ride custom_prompt and the
// assistant message), so they live in one neutral module: the planner writes
// them, the stream interpreter uses the placeholder tool name, the handler
// re-exports them for tests. Keeping them here avoids consume -> plan.
import type { RenderStats } from '../translate.ts'

// The old magpie-aws-quick-bridge did this before every request and the same
// model behaved noticeably better. Claude Code's prompt opens by naming the
// product and the model; Amazon Quick is neither, and told to be one it argues
// about identity instead of doing the work. The line becomes what it means
// here: where the conversation comes from. The billing/model lines change with
// every request and say nothing the model can use, so they are dropped.
const AGENT_IDENTITY = [
  /You are Claude Code, Anthropic's CLI for Claude(?:, running within the Claude Agent SDK)?\./g,
  /You are a Claude agent, built on Anthropic's Claude Agent SDK\./g,
]
const AGENT_PLACE = 'This conversation comes from a coding agent running in a terminal or editor on the user\'s own machine.'
const BILLING_LINE = /^[ \t]{4,}(?:-\s*)?(?:billing|cost|subscription|plan|you are powered by)\b.*$/gim
const MODEL_LINE = /^[ \t]*(?:You are powered by|The exact model ID is)\b.*$/gim

export function agentNeutral(text: any) {
  let out = String(text ?? '')
  for (const re of AGENT_IDENTITY) out = out.replace(re, AGENT_PLACE)
  return out.replace(BILLING_LINE, '').replace(MODEL_LINE, '')
}

// One plain sentence of framing. The old bridge wrote a full paragraph about
// a "third-party relay"; the model does not need the plumbing, and wording
// that sounds like an override reads as prompt injection. This says only what
// the instructions are and where they apply.
export const RELAYED_NOTE = 'This conversation comes from a coding agent on the user\'s machine. Its system prompt is part of this conversation\'s instructions; follow it where it fits within your own guidelines. If no other instructions are given, the user\'s messages are the whole task.'

// The failure the old bridge saw: Quick plans in English and then translates
// the user's Chinese path/log/search words inside tool arguments, so the call
// looks for something that does not exist. The fix does not need language
// detection — copying technical strings exactly is right for every language.
export const EXACT_STRINGS_NOTE = 'Copy file names, paths, log lines, error messages and search terms exactly as they appear in the messages, files and tool results: never translate them.'

// The old bridge's reminder, shortened: Quick's built-in tools run on the
// remote service and cannot see the user's machine, and delegating to another
// agent does not give it access either. This is a capability fact, not a fight
// over who the model is — Quick's own prompt stays in charge of that.
export const DIRECT_WORK_NOTE = 'Use the client tools directly for this task — Quick\'s built-in tools run on a remote service and cannot see the user\'s machine, and delegating the work to another agent does not give it access either.'

// Quick's own system prompt asks for Quick-app UI markup (decision cards,
// artifacts). External clients render plain text/Markdown, so that markup
// leaks as raw tags. Scoped so code/file output (e.g. HTML <option>) is unaffected.
export const PLAIN_TEXT_NOTE = 'Reply formatting: don\'t emit AWS Quick UI tags (such as <decision>, <option> or a sources block) — this client shows them as raw text; when the user needs to choose, ask with a short numbered list. This only affects how replies are formatted, not code or file contents.'
// With client tools, a formatting note alone reads as "put files in the chat":
// verified live, the model then pasted the code instead of calling Write.
export const TOOLS_STILL_APPLY = 'When the user asks you to make or change something (a page, script, file or project), do it on the user\'s machine with the client tools — write the file rather than pasting its contents into the reply.'
// Placeholder tool name handed to the client when an <invoke> block can't be
// parsed (see consume in handler.ts): no client has it, so nothing runs.
export const INVALID_CALL_TOOL = 'aws_quick_invalid_tool_call'

// A turn can finish with reasoning but no answer at all. Claude Code renders
// that as "Thought for Ns" and then nothing: the assistant message is empty,
// so the conversation stalls until the user speaks again. Retrying this by
// default would buy another multi-minute silence, not correctness — so the
// default is to fail loudly and let the caller decide (`answerRetries` opts
// into a retry, same thread, one effort level lower).
export const EMPTY_ANSWER_NUDGE = 'You finished this turn without writing any answer. Do not reason further: reply to the user now in plain text, or call a client tool with an <invoke> block. If you were interrupted mid-thought, answer from what you already have and say what is still uncertain.'
export const EMPTY_ANSWER_LABEL = '[Quick 空回答] '
export const EMPTY_ANSWER_ERR = 'Quick 这一轮只输出了推理、没有给出任何回答（答案为空）。请重试，或把请求拆小；answerRetries 可调整自动重试次数。'

/**
 * What to tell the client about this turn's trimming, by reason.
 *
 * Silent by policy:
 *   - a squeezed <system-reminder>: Claude Code sends the same content as the
 *     system prompt, so it is hygiene, not a loss;
 *   - description-only tool caps (desc1200/600/300/120): schemas are intact,
 *     so tool arguments stay correct, and the cap hits every fresh session's
 *     first frame — a line per session nobody can act on reads as failure.
 * Still named: schema-dropping tiers (lite/names), history/attachment moves,
 * tool-result head+tail, a capped current message and a capped frame.
 */
export function cutNote(stats: RenderStats | null | undefined, clippedSystem: boolean) {
  const cut = stats?.cut || {}
  const parts: string[] = []
  if (cut.system || clippedSystem) parts.push('调用方的系统指令过长，已截短（规则可能不完整）')
  if (cut.preamble) {
    const tier = stats?.specTier || ''
    if (tier === 'lite') parts.push('工具说明过长，已省略参数结构、只留名称与描述（参数需按用途推断）')
    else if (tier === 'names') parts.push('工具说明过长，已只保留工具名')
    else if (!tier) parts.push('工具说明过长，已缩短各工具的描述（参数结构保留）')
    // desc* tiers: schemas kept, only long prose trimmed — stay silent
  }
  if (cut.history) parts.push(`有 ${cut.history} 条较早消息装不进一帧，已丢弃`)
  if (cut.tool) parts.push(`${cut.tool} 处工具结果过大，已保留头尾、省略中间（需要更多内容就在原工具上缩小范围重跑）`)
  if (cut.turn) parts.push('当前消息过长，已保留开头和结尾')
  if (cut.frame) parts.push('整帧装不下，已截短末尾')
  if (!parts.length) return ''
  return `Quick 单帧上限 64KB，这一轮做了取舍：${parts.join('；')}。`
}
