// One frame, one owner.
//
// Quick's user_message is hard-capped at 64 KB, and four things compete for
// it: the caller's system prompt, this turn's injected instructions, the tool
// spec, and the conversation. Every earlier bug in this area came from each
// site computing its own budget; this module is the only place that may.
//
// The order of concessions is the contract (see test/invariants.test.mjs):
//   1. system prompt         never clipped while it is within SYSTEM_RESERVE
//   2. the current message   whole, unless it cannot fit at all
//   3. tool spec             description trimmed -> lite -> names
//   4. history               dropped -> uploaded as an attachment
//   5. everything else       cut, and stated
import { byteLen, escapedBytes, capText, setInstructions } from '../translate.ts'
import { buildToolPreamble } from '../tools.ts'

/** What Quick accepts for one user_message; the plugin sends a little under. */
export const UPSTREAM_FRAME_LIMIT = 60 * 1024
/** Never let a monstrous system prompt starve the conversation. */
export const SYSTEM_RESERVE_CAP = 32 * 1024
/** Room for the envelope: thread id, base fields, JSON keys. */
export const ENVELOPE_RESERVE = 1536
/** The transcript is JSON-escaped too; ~3% headroom covers newlines/quotes. */
export const ESCAPE_HEADROOM = 1.03

export type ConcessionCode =
  | 'system' | 'preamble-desc' | 'preamble-lite' | 'preamble-names'
  | 'history-drop' | 'tool-shrink' | 'turn-cap'
  | 'frame-tail' | 'reminder'

export type Concession = {
  code: ConcessionCode
  /** How many times this concession was taken this turn. */
  count: number
  /** What the client is told; '' keeps it silent (duplicated context only). */
  note: string
}

export const CONCESSION_NOTES: Record<ConcessionCode, string> = {
  'system': '调用方的系统指令过长，已截短（规则可能不完整）',
  'preamble-desc': '工具说明过长，已缩短各工具的描述（参数结构保留）',
  'preamble-lite': '工具说明过长，已省略参数结构、只留名称与描述（参数需按用途推断）',
  'preamble-names': '工具说明过长，已只保留工具名',
  'history-drop': '有较早消息装不进一帧，已丢弃',
  'tool-shrink': '工具结果过大，已保留头尾、省略中间（需要更多内容就在原工具上缩小范围重跑）',
  'turn-cap': '当前消息过长，已保留开头和结尾',
  'frame-tail': '整帧装不下，已截短末尾',
  'reminder': '',
}

/** Bytes the frame costs for a given text/prompt pair, envelope included. */
export function frameBytes(threadId: string | undefined, payload: Record<string, unknown>): number {
  return byteLen(JSON.stringify({ type: 'user_message', payload: { ...(threadId ? { thread_id: threadId } : {}), ...payload } }))
}

/** Exact extra encoded text room after actual attachment metadata is known. */
export function remainingTextRoom(input: {
  threadId: string
  payload: Record<string, unknown>
  systemText: string
  customPrompt: string
}): number {
  const probe = { ...input.payload }
  const reservedSystem = capText(input.systemText, SYSTEM_RESERVE_CAP, escapedBytes)
  // No thread ID means lossless placement of the reserved instructions.
  setInstructions(probe, reservedSystem, input.customPrompt)
  return Math.max(0, UPSTREAM_FRAME_LIMIT - frameBytes(input.threadId, probe))
}

/**
 * Bytes left for (preamble + body) once the instructions are reserved.
 * Both the system prompt and the plugin's own notes cost their escaped size:
 * reserving raw bytes left the frame a few hundred short and clipped rules.
 */
export function frameRoom(input: { systemText: string; customPrompt: string }): number {
  const systemReserve = Math.min(input.systemText ? escapedBytes(input.systemText) : 0, SYSTEM_RESERVE_CAP)
  const promptReserve = escapedBytes(input.customPrompt)
  const room = UPSTREAM_FRAME_LIMIT - systemReserve - promptReserve - ENVELOPE_RESERVE
  return Math.max(8 * 1024, Math.floor(room / ESCAPE_HEADROOM))
}

export type PreambleTier = 'full' | 'desc1200' | 'desc600' | 'desc300' | 'desc120' | 'lite' | 'names'

const TIERS: Array<{ tier: PreambleTier; opts: Record<string, unknown> }> = [
  { tier: 'full', opts: {} },
  { tier: 'desc1200', opts: { descCap: 1200 } },
  { tier: 'desc600', opts: { descCap: 600 } },
  { tier: 'desc300', opts: { descCap: 300 } },
  { tier: 'desc120', opts: { descCap: 120 } },
  { tier: 'lite', opts: { lite: true } },
  { tier: 'names', opts: { namesOnly: true } },
]

const TIER_CONCESSION: Record<Exclude<PreambleTier, 'full'>, ConcessionCode> = {
  'desc1200': 'preamble-desc', 'desc600': 'preamble-desc', 'desc300': 'preamble-desc',
  'desc120': 'preamble-desc', 'lite': 'preamble-lite', 'names': 'preamble-names',
}

/**
 * The tool spec, compressed only as far as `room` requires and always in the
 * same order: truncate the prose descriptions (they are 4x the structural
 * schema for Claude Code's toolset) and keep the schemas, which keep the
 * arguments correct. Jumping straight to lite once freed 23 KB to cover a
 * 1.6 KB shortfall and left the model guessing parameter names.
 */
export function pickPreamble(input: {
  tools: unknown[]
  toolChoice?: unknown
  room: number
  need?: number
}): { preamble: string; tier: PreambleTier; concession?: ConcessionCode } {
  const { tools, toolChoice, room, need = 0 } = input
  if (!tools.length) return { preamble: '', tier: 'full' }
  // buildToolPreamble drops parameter schemas on its own when a spec exceeds
  // PREAMBLE_CAP (40 KB). That is the 'lite' tier's loss, so report it as one:
  // otherwise pickPreamble sees a small 'full' string and no note is shown
  // for a silent schema drop.
  const liteProbe = buildToolPreamble(tools, toolChoice, { lite: true })
  const effectiveTier = (tier: PreambleTier, preamble: string): PreambleTier =>
    ((tier === 'full' || tier.startsWith('desc')) && preamble === liteProbe ? 'lite' : tier)
  let best: { preamble: string; tier: PreambleTier } | null = null
  for (const { tier, opts } of TIERS) {
    const preamble = buildToolPreamble(tools, toolChoice, opts)
    const effective = effectiveTier(tier, preamble)
    if (!best || byteLen(preamble) < byteLen(best.preamble)) best = { preamble, tier: effective }
    if (byteLen(preamble) <= room - need - 512) {
      return effective === 'full' ? { preamble, tier: effective } : { preamble, tier: effective, concession: TIER_CONCESSION[effective as Exclude<PreambleTier, 'full'>] }
    }
  }
  const fallback = best ?? { preamble: '', tier: 'full' as PreambleTier }
  return { ...fallback, concession: fallback.tier === 'full' ? undefined : TIER_CONCESSION[fallback.tier as Exclude<PreambleTier, 'full'>] }
}

/** Merge one concession into the turn's list (same code accumulates). */
export function addConcession(list: Concession[], code: ConcessionCode, n = 1): Concession[] {
  const note = CONCESSION_NOTES[code]
  const found = list.find((c) => c.code === code)
  if (found) found.count += n
  else list.push({ code, count: n, note })
  return list
}

/** The one note a turn shows for its concessions; '' when nothing was lost. */
export function concessionNote(list: Concession[]): string {
  const parts = list.filter((c) => c.note).map((c) => (c.count > 1 && c.code === 'history-drop' ? `有 ${c.count} 条较早消息装不进一帧，已丢弃` : c.note))
  if (!parts.length) return ''
  return `Quick 单帧上限 64KB，这一轮做了取舍：${parts.join('；')}。`
}
