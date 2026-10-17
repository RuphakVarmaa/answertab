// buildApp({ db }): the Fastify instance (tests drive it with app.inject). index.ts adds listening, jobs and status.
import { existsSync } from 'node:fs'
import path from 'node:path'
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import { config } from './config.js'
import { setDb, type Db } from './db/db.js'
import { initDomain, toHttpError } from './domain/index.js'
import { sha256 } from './ids.js'
import { apiRoutes } from './routes/index.js'
import { startSseHub } from './sse.js'

export interface BuildAppOptions {
  db: Db
  /** Built web app to serve (dist/web). Omit or null for API only. */
  webDir?: string | null
  logger?: FastifyServerOptions['logger']
  /** false disables rate limits (load tests only). */
  rateLimit?: boolean
  /** Proxy hops to trust for the client IP (Render: 1). Default from TRUST_PROXY, else none. */
  trustProxy?: boolean | number
}

export const BODY_LIMIT = 64 * 1024
const GLOBAL_LIMIT_PER_MIN = 300

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Logged URLs never carry tokens or the judge code (SSE ?token= and its k= / t= aliases, /f/:room?t=, /?code=, receipt paths). */
export function redactUrl(url: string): string {
  return url.replace(/([?&;](?:token|k|t|code)=)[^&#;]*/gi, '$1REDACTED').replace(/\/receipts\/[^/?]+/g, '/receipts/REDACTED').replace(/(\/r\/)[^/?]+/g, '$1REDACTED')
}

function trustProxyFromEnv(): boolean | number {
  const v = process.env.TRUST_PROXY
  if (!v) return false
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 ? n : v === 'true'
}

/** A hop count becomes "trust the nearest n proxies" (X-Forwarded-For is otherwise client-controlled). */
function trustProxyOption(v: boolean | number): boolean | ((addr: string, hop: number) => boolean) {
  return typeof v === 'number' ? (_addr, hop) => hop < v : v
}

function rateKey(req: { ip: string; headers: Record<string, unknown>; query?: unknown }): string {
  const q = (req.query ?? {}) as { token?: unknown }
  const t = req.headers['x-creator-token'] ?? req.headers['x-fan-token'] ?? q.token
  return `${req.ip}|${typeof t === 'string' && t ? sha256(t).slice(0, 16) : '-'}`
}

/** JSON without prototype keys; an empty body is {} (some clients send a content-type with no body). */
function parseJson(body: string): unknown {
  if (body.trim() === '') return {}
  return JSON.parse(body, (k, v) => (k === '__proto__' || k === 'constructor' ? undefined : v))
}

/** Coarse per-IP ceiling across the API, on top of the per-route IP+token limits (fixed one-minute windows). */
export const IP_LIMIT_PER_MIN = 1500
function ipCeiling(): (ip: string) => boolean {
  const windows = new Map<string, { start: number; n: number }>()
  return (ip) => {
    const t = Date.now()
    const w = windows.get(ip)
    if (!w || t - w.start >= 60_000) {
      if (windows.size > 50_000) for (const [k, v] of windows) if (t - v.start >= 60_000) windows.delete(k)
      windows.set(ip, { start: t, n: 1 })
      return true
    }
    w.n++
    return w.n <= IP_LIMIT_PER_MIN
  }
}

export function buildApp(opts: BuildAppOptions): FastifyInstance {
  setDb(opts.db)
  initDomain()
  startSseHub()
  const cfg = config()
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: BODY_LIMIT,
    trustProxy: trustProxyOption(opts.trustProxy ?? trustProxyFromEnv()),
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false, allErrors: false } },
  })

  app.removeContentTypeParser('application/json')
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, parseJson(String(body)))
    } catch {
      const err = new Error('Body is not valid JSON.') as Error & { statusCode: number; code: string }
      err.statusCode = 400
      err.code = 'bad_json'
      done(err, undefined)
    }
  })

  const allowedOrigin = new URL(cfg.publicBaseUrl).origin
  app.addHook('onRequest', async (req, reply) => {
    // Same-origin only: no CORS headers are ever sent, and cross-site writes are refused outright.
    const origin = req.headers.origin
    if (origin && !SAFE_METHODS.has(req.method) && req.url.startsWith('/api/')) {
      let host: string | null = null
      try {
        host = new URL(origin).host
      } catch {
        host = null
      }
      if (origin !== allowedOrigin && host !== req.headers.host) {
        return reply.code(403).send({ error: { code: 'cross_origin', message: 'Cross-origin requests are not allowed.' } })
      }
    }
  })

  if (opts.rateLimit !== false) {
    const underCeiling = ipCeiling()
    app.addHook('onRequest', async (req, reply) => {
      if (req.url.startsWith('/api/') && !req.url.includes('/events') && !underCeiling(req.ip)) {
        return reply.code(429).send({ error: { code: 'rate_limited', message: 'Too many requests from this network. Slow down a little.' } })
      }
    })
  }

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin')
    reply.header('X-Frame-Options', 'SAMEORIGIN')
    if (req.url.startsWith('/api/') && !reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store')
    return payload
  })

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown; code?: string }, req, reply) => {
    if (err.validation) {
      // Schema text ("params/token must match pattern ...") is for logs, not people.
      const ctx = (err as { validationContext?: string }).validationContext
      const message = ctx === 'params' ? "That link isn't valid. Check that it was copied in full." : "Some of that input isn't valid. Check it and try again."
      req.log.info({ validation: err.message, url: redactUrl(req.url) }, 'validation failed')
      return reply.code(400).send({ error: { code: ctx === 'params' ? 'bad_link' : 'bad_request', message } })
    }
    if (err.statusCode === 429) return reply.code(429).send({ error: { code: 'rate_limited', message: 'Too many requests. Slow down a little.' } })
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500 && err.name !== 'DomainError') {
      const code = err.code === 'bad_json' ? 'bad_json' : err.statusCode === 413 ? 'payload_too_large' : err.statusCode === 415 ? 'unsupported_media_type' : 'bad_request'
      return reply.code(err.statusCode).send({ error: { code, message: err.message } })
    }
    const { status, body } = toHttpError(err)
    if (status >= 500) req.log.error({ err: { name: err.name, message: err.message }, url: redactUrl(req.url) }, 'request failed')
    return reply.code(status).send(body)
  })

  if (opts.rateLimit !== false) {
    app.register(rateLimit, {
      global: true,
      max: GLOBAL_LIMIT_PER_MIN,
      timeWindow: 60_000,
      keyGenerator: rateKey,
      allowList: (req) => req.url === '/healthz',
    })
  }
  app.register(apiRoutes)

  const webDir = opts.webDir ? path.resolve(opts.webDir) : null
  const hasWeb = !!webDir && existsSync(path.join(webDir, 'index.html'))
  if (hasWeb) {
    app.register(fastifyStatic, {
      root: webDir!,
      prefix: '/',
      // Resolve files at request time so a rebuild never leaves the server pointing at deleted hashes.
      wildcard: true,
      index: ['index.html'],
      setHeaders: (res, file) => {
        res.header('Cache-Control', /[/\\]assets[/\\]/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache')
      },
    })
  }

  app.setNotFoundHandler((req, reply) => {
    const isApi = req.url.startsWith('/api/') || req.url === '/api' || req.url.startsWith('/webhooks/') || req.url === '/healthz'
    // A missing build file must 404, not fall back to index.html (the browser would get HTML for a script).
    const isAsset = req.url.startsWith('/assets/') || /\.[a-z0-9]{1,8}(\?|$)/i.test(req.url.split('#')[0] ?? '')
    if (!isApi && !isAsset && hasWeb && (req.method === 'GET' || req.method === 'HEAD')) {
      // SPA fallback: client routes (/c/:room, /f/:room, /r/:token, ...) all load index.html.
      return reply.header('Cache-Control', 'no-cache').type('text/html; charset=utf-8').sendFile('index.html')
    }
    return reply.code(404).send({ error: { code: 'not_found', message: 'Not found.' } })
  })

  return app
}
