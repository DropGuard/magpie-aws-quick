#!/usr/bin/env node
// Standalone fallback: an OpenAI-compatible proxy on 127.0.0.1 for the same
// adapter, for when you would rather add Amazon Quick to magpie as a custom
// provider (magpie provider add … --base-url http://127.0.0.1:PORT/v1) than
// load the plugin, or use it from any other OpenAI-compatible client.
//
//   node bin/serve.mjs                  # boots the Quick outpost lazily on first request
//   PORT=3426  HOST=127.0.0.1
//   PROXY_TOKEN=…                       # require "Authorization: Bearer <PROXY_TOKEN>" (recommended)
//   QUICK_AGENT_PATH=…                  # explicit quickwork-agent(.exe)
//   QUICK_AGENT_ZIP=…                   # explicit resources/agent.zip to extract
//   QUICK_SESSION_REUSE=0               # send every request on a fresh Quick thread
//   QUICK_SESSION_TTL_MS=1800000  QUICK_SESSION_MAX=200
//   QUICK_REQUEST_TIMEOUT_MS=600000       # whole-call deadline; 0 disables it
//   QUICK_MAX_TURN_ATTEMPTS=3              # total attempts, including the first
import { createServer } from 'node:http'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { handleChatCompletions, handleModels } from '../src/handler.ts'
import { createOutpostManager } from '../src/outpost.ts'
import { createSessionStore, SESSION_DEFAULTS } from '../src/sessions.ts'
import { requestOptions } from '../src/request-context.ts'
import { abortable, createCallScope, DEFAULT_CALL_TIMEOUT_MS } from '../src/runtime/deadline.ts'
import { httpStatus, errorType } from '../src/http/respond.ts'

function readBody(req, scope) {
  return scope.wait(new Promise((resolve, reject) => {
    let raw = ''
    const cleanup = () => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      scope.signal.removeEventListener('abort', onAbort)
    }
    const onData = (chunk) => { raw += chunk }
    const onEnd = () => { cleanup(); resolve(raw) }
    const onError = (error) => { cleanup(); reject(error) }
    const onAbort = () => {
      cleanup()
      req.resume() // discard any remaining upload without retaining its body
      reject(scope.signal.reason)
    }
    req.setEncoding('utf8')
    req.on('data', onData).once('end', onEnd).once('error', onError)
    scope.signal.addEventListener('abort', onAbort, { once: true })
    if (scope.signal.aborted) onAbort()
  }))
}

export function createProxyServer({ options = {}, token = '', outpostMgr, sessions } = {}) {
  const configuredTimeout = options.requestTimeoutMs == null || options.requestTimeoutMs === ''
    ? DEFAULT_CALL_TIMEOUT_MS : Number(options.requestTimeoutMs)
  const timeoutMs = Number.isFinite(configuredTimeout) ? configuredTimeout : DEFAULT_CALL_TIMEOUT_MS
  return createServer(async (req, res) => {
    const scope = createCallScope({ timeoutMs })
    // A deadline stops model work but must still let its SSE error + DONE flush.
    // Only physical client disconnects cancel the response pipe itself.
    const disconnected = new AbortController()
    const onRequestAbort = () => { scope.abort(); disconnected.abort() }
    // IncomingMessage also emits close after a normally completed upload.
    const onRequestClose = () => { if (!req.complete) onRequestAbort() }
    const onResponseClose = () => { if (!res.writableEnded) onRequestAbort() }
    req.once('aborted', onRequestAbort)
    req.once('close', onRequestClose)
    res.once('close', onResponseClose)
    try {
      const url = new URL(req.url, 'http://local')
      const path = url.pathname.replace(/\/+$/, '')
      if (token) {
        const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-api-key'] || ''
        if (got !== token) {
          res.writeHead(401, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ error: { message: 'bad proxy token', type: 'authentication_error' } }))
        }
      }
      if (req.method === 'GET' && (path === '/health' || path === '')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ ok: true }))
      }
      let out
      if (req.method === 'GET' && /\/models$/.test(path)) out = handleModels()
      else if (req.method === 'POST' && /\/chat\/completions$/.test(path)) {
        const raw = await readBody(req, scope)
        let body
        try { body = JSON.parse(raw || '{}') } catch {
          res.writeHead(400, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ error: { message: 'request body must be JSON', type: 'invalid_request_error' } }))
        }
        const { effortHeader, ...headers } = requestOptions((name) => {
          const value = req.headers[name]
          return Array.isArray(value) ? value[0] : value
        })
        out = await scope.wait(handleChatCompletions({
          body, outpostMgr, sessions,
          options: { ...options, ...Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined)) },
          effortHeader, signal: scope.signal, callScope: scope,
        }))
      } else {
        res.writeHead(404, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: { message: `not found: ${req.method} ${path}`, type: 'invalid_request_error' } }))
      }
      disconnected.signal.throwIfAborted()
      res.writeHead(out.status, Object.fromEntries(out.headers))
      if (!out.body) return res.end()
      const reader = out.body.getReader()
      let complete = false
      try {
        while (true) {
          const { done, value } = await abortable(reader.read(), disconnected.signal)
          if (done) { complete = true; break }
          if (!res.write(value)) await once(res, 'drain', { signal: disconnected.signal })
        }
      } finally {
        if (!complete) await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
      if (!res.destroyed && !res.writableEnded) res.end()
    } catch (error) {
      const e = scope.normalize(error)
      if (res.destroyed || res.writableEnded) return
      // Once streaming headers/data are sent, never append a second JSON reply.
      if (res.headersSent) return res.destroy()
      if (!req.complete) res.setHeader('connection', 'close')
      const status = httpStatus(e)
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: String(e?.message ?? e), type: errorType(e), code: status } }))
    } finally {
      req.off('aborted', onRequestAbort)
      req.off('close', onRequestClose)
      res.off('close', onResponseClose)
      scope.dispose()
    }
  })
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const port = Number(process.env.PORT || 3426)
  const host = process.env.HOST || '127.0.0.1'
  const options = {}
  if (process.env.QUICK_AGENT_PATH) options.agentPath = process.env.QUICK_AGENT_PATH
  if (process.env.QUICK_AGENT_ZIP) options.agentZip = process.env.QUICK_AGENT_ZIP
  if (process.env.QUICK_USER_DATA_DIR) options.userDataDir = process.env.QUICK_USER_DATA_DIR
  if (process.env.QUICK_CACHE_DIR) options.cacheDir = process.env.QUICK_CACHE_DIR
  if (process.env.QUICK_OUTPOST_PORT) options.port = Number(process.env.QUICK_OUTPOST_PORT)
  if (process.env.QUICK_BUILD_STAGE) options.buildStage = process.env.QUICK_BUILD_STAGE
  if (process.env.QUICK_REQUEST_TIMEOUT_MS !== undefined) options.requestTimeoutMs = Number(process.env.QUICK_REQUEST_TIMEOUT_MS)
  if (process.env.QUICK_MAX_TURN_ATTEMPTS !== undefined) options.maxTurnAttempts = Number(process.env.QUICK_MAX_TURN_ATTEMPTS)
  const reuse = !/^(0|false|off|no)$/i.test(process.env.QUICK_SESSION_REUSE ?? '')
  const sessions = reuse
    ? createSessionStore({
        ttlMs: Number(process.env.QUICK_SESSION_TTL_MS) > 0 ? Number(process.env.QUICK_SESSION_TTL_MS) : SESSION_DEFAULTS.ttlMs,
        max: Number(process.env.QUICK_SESSION_MAX) > 0 ? Number(process.env.QUICK_SESSION_MAX) : SESSION_DEFAULTS.max,
      })
    : undefined
  const outpostMgr = createOutpostManager({ ...options, log: (l) => console.error('[outpost]', l) })
  createProxyServer({ options: { ...options, identity: 'aws-quick-proxy' }, token: process.env.PROXY_TOKEN || '', outpostMgr, sessions }).listen(port, host, () => {
    console.error(`aws-quick proxy listening on http://${host}:${port}/v1 (outpost starts on first request)`)
  })
}
