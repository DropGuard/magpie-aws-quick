// Getting a turn's side content into Quick: images and an oversized transcript.
//
// Images ride user_message.attachments — small ones inline as base64 inside the
// frame, larger ones through Quick's cloud attachment upload. When a fresh
// thread's transcript does not fit one frame, the conversation is uploaded as
// a text file and the frame keeps a pointer plus the newest message (silently
// cutting the middle is what made the model "forget" the task).
import crypto from 'node:crypto'
import { uploadFile, uploadImage } from '../attach.ts'
import { renderTranscript, textOf, byteLen, canonRole, pickImages } from '../translate.ts'

// A transcript that cannot fit one 64 KB frame travels as a cloud attachment
// (the desktop upload flow takes text files). Refuse absurd sizes rather than
// pushing gigabytes at the upload endpoint.
const MAX_CONTEXT_ATTACHMENT = 32 * 1024 * 1024
export const CONTEXT_ATTACHED_NOTE = '上下文超过 Quick 64KB 单帧上限，已把最后一条消息之前的对话作为附件传给 Quick（模型会先读取该文件）'
export const TOO_LONG_ERR = "context_length_exceeded: the conversation does not fit Amazon Quick's 64 KB message limit and uploading it as a context attachment failed"
// Text room kept free when inline images claim the frame.
const IMAGE_TEXT_RESERVE = 8 * 1024
/** A tool result above this size, when the frame had to cut it, is uploaded
 *  instead: the file keeps all of it and the frame points at the file. 8 KB,
 *  not 32: a single re-read costs a whole model turn (20-40 s), an upload ~1 s,
 *  and medium results are exactly what gets water-filled when several share
 *  the frame. */
export const TOOL_UPLOAD_MIN = 8 * 1024
const TOOL_UPLOADS_PER_TURN = 2

/**
 * Split this turn's images into inline / upload / skipped, against the text
 * budget the frame leaves them.
 */
export function pickTurnImages({ convo, reuse, textBudget }: { convo: any[]; reuse?: { delta: any[] } | null; textBudget: number }) {
  const lastAsst = convo.findLastIndex((m) => canonRole(m.role) === 'assistant')
  const slice = reuse ? reuse.delta : convo.slice(lastAsst + 1)
  return pickImages(slice, Math.max(0, textBudget - IMAGE_TEXT_RESERVE), { upload: true })
}

export interface AttachmentFlow {
  /** Note about images that could not be delivered (empty when all landed). */
  imageNoteFor: (failed: number) => string
  /** Deliver the queued uploads into tid's cloud workspace, in parallel. */
  uploadAll: (tid: string) => Promise<{ entries: any[]; failed: number }>
  /** Upload the conversation as a text file (null when disabled). */
  attachContext: (tid: string) => Promise<any>
  /** Pointer text for a transcript replaced by the attachment, plus the newest message. */
  attachPointer: (attachment: any) => string
  /** Upload one oversized tool result; null when it could not be delivered. */
  uploadToolResult: (tid: string, name: string, text: string) => Promise<any | null>
}

export function createAttachmentFlow({ outpost, options, signal, convo, images }: {
  outpost: any
  options: any
  signal?: AbortSignal
  convo: any[]
  images: any
}): AttachmentFlow {
  const imageNoteFor = (uploadFailed: number) => {
    const n = images.skipped + uploadFailed
    return n ? `\n\n[${n} image(s) not delivered: too large, upload failed, or not inline data]` : ''
  }
  // Deliver the queued uploads into tid's cloud workspace, in parallel.
  // Failures degrade to the not-delivered note; aborts propagate.
  const uploadAll = async (tid: string) => {
    if (!images.toUpload.length) return { entries: [] as any[], failed: 0 }
    signal?.throwIfAborted()
    const sess = await outpost.session()
    signal?.throwIfAborted()
    const devId = await Promise.resolve(outpost.outpostId?.()).catch(() => '')
    signal?.throwIfAborted()
    const results = await Promise.allSettled(images.toUpload.map((img) =>
      uploadImage({
        session: sess, image: img, name: img.name, threadId: tid, outpostId: devId || undefined,
        fetchImpl: options?.fetchImpl ?? globalThis.fetch, signal,
        // best-effort: an image that cannot land is named, not waited on
        timeoutMs: 30_000,
      })
    ))
    const entries: any[] = []
    let failed = 0
    for (const r of results) {
      if (r.status === 'fulfilled') { entries.push(r.value); continue }
      if (signal?.aborted || r.reason?.name === 'AbortError') throw r.reason
      failed++
      options?.log?.(`[aws-quick] image upload failed: ${String(r.reason?.message ?? r.reason).slice(0, 200)}`)
    }
    return { entries, failed }
  }
  // A fresh thread carries the whole conversation in one 64 KB frame. When the
  // transcript does not fit, silently dropping its middle is what makes the
  // model "forget" the task and re-read everything each turn, so send the
  // conversation as a cloud attachment instead (the desktop flow takes text
  // files; the model's own file tool reads the workspace path) and keep only a
  // pointer plus the newest message in the frame. Attaching is best-effort:
  // when it fails the turn errors out, so the client compacts its own history
  // instead of working from a gutted transcript — a silent cut is the worse
  // failure (the old bridge behaved this way and stayed usable).
  const attachContext = async (tid: string) => {
    if (options?.contextAttachments === false) return null
    // The old bridge uploads the conversation UP TO the last message and keeps
    // that last message in the frame (when it is short). The model reads the
    // whole file before acting, so nothing is lost and the current turn is
    // still visible without a file read.
    const lastMsg = convo.at(-1)
    const lastText = lastMsg ? textOf(lastMsg.content) : ''
    const keepLast = convo.length > 1 && byteLen(lastText) <= 6000
    const older = keepLast ? convo.slice(0, -1) : convo
    const full = renderTranscript(older, '', { lossless: true })
    const bytes = Buffer.from(full, 'utf8')
    if (bytes.length > MAX_CONTEXT_ATTACHMENT) {
      throw Object.assign(new Error(`conversation is ${bytes.length} bytes, over the ${MAX_CONTEXT_ATTACHMENT}-byte attachment cap`), { reason: 'size' })
    }
    const name = `context_${crypto.randomUUID().slice(0, 8)}.txt`
    signal?.throwIfAborted()
    const sess = await outpost.session()
    signal?.throwIfAborted()
    const devId = await Promise.resolve(outpost.outpostId?.()).catch(() => '')
    signal?.throwIfAborted()
    const entry = await uploadFile({
      session: sess,
      name,
      mimeType: 'text/plain',
      bytes,
      threadId: tid,
      outpostId: devId || undefined,
      fetchImpl: options?.fetchImpl ?? globalThis.fetch,
      signal,
      // required for the turn to work: bounded, then fail loudly (the client
      // compacts) rather than waiting for the idle watchdog
      timeoutMs: Number(options?.contextUploadTimeoutMs) > 0 ? Number(options.contextUploadTimeoutMs) : 120_000,
    })
    return { entry, last: keepLast ? lastText : '' }
  }
  // Pointer text: the conversation up to the last message is in the file; the
  // last message itself rides in the frame when it was short enough.
  const attachPointer = (attachment: any) => {
    const entry = attachment?.entry ?? attachment
    const last = String(attachment?.last ?? '')
    const lead = `[The conversation up to the last message is in the attached file ${entry.name} (${entry.size} bytes) because it is too long to send here. Read the whole file with your file tool before anything else, then carry on from it exactly as if its text had been sent in this message. Do not mention the file or that you are reading it.]`
    return last ? `${lead}\n\n${last}` : lead
  }
  // Best-effort: when the frame had to cut a huge tool result, the full output
  // goes to a file and the frame keeps a pointer. A failed upload falls back to
  // the truncation the caller already rendered.
  const uploadToolResult = async (tid: string, name: string, text: string) => {
    try {
      signal?.throwIfAborted()
      const sess = await outpost.session()
      signal?.throwIfAborted()
      const devId = await Promise.resolve(outpost.outpostId?.()).catch(() => '')
      signal?.throwIfAborted()
      return await uploadFile({
        session: sess, name, mimeType: 'text/plain', bytes: Buffer.from(text, 'utf8'),
        threadId: tid, outpostId: devId || undefined,
        fetchImpl: options?.fetchImpl ?? globalThis.fetch,
        signal,
        // best-effort: a dead endpoint falls back to the truncation, quickly
        timeoutMs: Number(options?.toolUploadTimeoutMs) > 0 ? Number(options.toolUploadTimeoutMs) : 20_000,
      })
    } catch (e: any) {
      // Only the caller's abort propagates; our own upload timeout aborts the
      // composed signal without touching the caller's, and must fall back.
      if (signal?.aborted) throw e
      options?.log?.(`[aws-quick] tool-result upload failed: ${String(e?.message ?? e).slice(0, 200)}`)
      return null
    }
  }
  return { imageNoteFor, uploadAll, attachContext, attachPointer, uploadToolResult }
}
