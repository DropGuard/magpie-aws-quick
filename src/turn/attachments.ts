// Getting a turn's side content into Quick: images and an oversized transcript.
//
// Images ride user_message.attachments — small ones inline as base64 inside the
// frame, larger ones through Quick's cloud attachment upload. When a fresh
// thread's transcript does not fit one frame, the conversation is uploaded as
// a text file and the frame keeps a pointer plus the newest message (silently
// cutting the middle is what made the model "forget" the task).
import crypto from 'node:crypto'
import { uploadFile, uploadImage } from '../attach.ts'
import { renderTranscript, textOf, byteLen, capMiddle, canonRole, pickImages } from '../translate.ts'

// A transcript that cannot fit one 64 KB frame travels as a cloud attachment
// (the desktop upload flow takes text files). Refuse absurd sizes rather than
// pushing gigabytes at the upload endpoint.
const MAX_CONTEXT_ATTACHMENT = 32 * 1024 * 1024
export const CONTEXT_ATTACHED_NOTE = '上下文超过 Quick 64KB 单帧上限，已把完整对话作为附件传给 Quick（模型会先读取该文件）'
export const TOO_LONG_ERR = "context_length_exceeded: the conversation does not fit Amazon Quick's 64 KB message limit and uploading it as a context attachment failed"
// Text room kept free when inline images claim the frame.
const IMAGE_TEXT_RESERVE = 8 * 1024

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
  /** Upload the full conversation as a text file (null when disabled). */
  attachContext: (tid: string) => Promise<any>
  /** Pointer text for a transcript replaced by `entry`. */
  attachPointer: (entry: any, headroom: number) => string
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
    const sess = await outpost.session()
    const devId = await Promise.resolve(outpost.outpostId?.()).catch(() => '')
    const results = await Promise.allSettled(images.toUpload.map((img) =>
      uploadImage({
        session: sess, image: img, name: img.name, threadId: tid, outpostId: devId || undefined,
        fetchImpl: options?.fetchImpl ?? globalThis.fetch, signal,
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
    const full = renderTranscript(convo, '', { lossless: true })
    const bytes = Buffer.from(full, 'utf8')
    if (bytes.length > MAX_CONTEXT_ATTACHMENT) {
      throw Object.assign(new Error(`conversation is ${bytes.length} bytes, over the ${MAX_CONTEXT_ATTACHMENT}-byte attachment cap`), { reason: 'size' })
    }
    const name = `context_${crypto.randomUUID().slice(0, 8)}.txt`
    const sess = await outpost.session()
    const devId = await Promise.resolve(outpost.outpostId?.()).catch(() => '')
    return uploadFile({
      session: sess,
      name,
      mimeType: 'text/plain',
      bytes,
      threadId: tid,
      outpostId: devId || undefined,
      fetchImpl: options?.fetchImpl ?? globalThis.fetch,
      signal,
    })
  }
  // Pointer text for a transcript replaced by `entry`: the newest message rides
  // along so the model can act without waiting for a file read.
  const attachPointer = (entry: any, headroom: number) => {
    const last = convo.at(-1)
    let tail = ''
    if (last) {
      const role = canonRole(last.role)
      const body = textOf(last.content)
      if (role === 'tool') tail = `[tool_result ${[last.name, last.tool_call_id].filter(Boolean).join(' ')}]\n${body}`
      else if (role === 'user') tail = body
    }
    const lead = `[The conversation so far is in the attached file ${entry.name} (${entry.size} bytes). It was too long to send as one message. Read the whole file with your file tool before anything else, then continue from it exactly as if its text had been sent here. Do not mention the file or that you are reading it.]`
    if (!tail) return lead
    return `${lead}\n\n${capMiddle(tail, Math.max(2 * 1024, headroom - byteLen(lead) - 256))}`
  }
  return { imageNoteFor, uploadAll, attachContext, attachPointer }
}
