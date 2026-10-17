// Runs @paypal/agent-toolkit 1.11.0 tools (get_order, get_dispute, create_refund, get_refund) from server code.
// A fresh toolkit instance per action: it fetches its own token once and never refreshes it, and it sends
// context.request_id as PayPal-Request-Id on every call. Its run() swallows errors into JSON strings and drops
// status codes and debug ids, so we trace its axios traffic (AsyncLocalStorage-scoped interceptors) to give the
// ledger the real HTTP status, PayPal-Debug-Id, latency and body of each request it made.
import { AsyncLocalStorage } from 'node:async_hooks'
import { createRequire } from 'node:module'
import { config } from '../config.js'
import { fromHttpResponse, localError, parseJsonSafe, toPayPalError, type PayPalError } from './errors.js'
import { record } from './ledger.js'
import { paypalLimit } from './limiter.js'
import { pickHeaders } from './redact.js'
import type { CallMeta, CallResult } from './client.js'
import type { LedgerCallView } from '../../shared/types.js'

export type ToolkitTool = 'create_refund' | 'get_refund' | 'get_order' | 'get_dispute'

const ACTIONS = {
  payments: { createRefund: true, getRefunds: true },
  orders: { get: true },
  disputes: { get: true },
}

interface Traced {
  method: string
  url: string
  status: number
  debugId: string | null
  latencyMs: number
  requestHeaders: Record<string, string>
  requestBody: unknown
  responseBody: unknown
  responseHeaders: Record<string, unknown>
}

type ToolkitModule = typeof import('@paypal/agent-toolkit/ai-sdk')

// Minimal shape of the axios default instance the toolkit uses (we never import axios ourselves).
interface AxiosLike {
  interceptors: {
    request: { use(onOk: (cfg: any) => any): number }
    response: { use(onOk: (res: any) => any, onErr: (err: any) => any): number }
  }
}

// Process-wide (Symbol.for): if this module is evaluated twice (watch mode, test isolation) the interceptors
// installed on the shared axios instance keep reading the same store, and are installed only once.
const TRACE_KEY = Symbol.for('answertab.paypal.toolkitTrace')
const INSTALLED_KEY = Symbol.for('answertab.paypal.toolkitTraceInstalled')
const START = Symbol.for('answertab.paypal.toolkitStart')
const g = globalThis as { [TRACE_KEY]?: AsyncLocalStorage<Traced[]> }
const trace: AsyncLocalStorage<Traced[]> = (g[TRACE_KEY] ??= new AsyncLocalStorage<Traced[]>())
let loaded: ToolkitModule | null = null

function headerMap(h: unknown): Record<string, unknown> {
  if (!h || typeof h !== 'object') return {}
  const plain = typeof (h as { toJSON?: () => unknown }).toJSON === 'function' ? (h as { toJSON: () => unknown }).toJSON() : h
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(plain as Record<string, unknown>)) out[k.toLowerCase()] = v
  return out
}

function traced(cfg: any, status: number, headers: unknown, data: unknown): Traced {
  const resHeaders = headerMap(headers)
  const started = typeof cfg?.[START] === 'number' ? (cfg[START] as number) : performance.now()
  return {
    method: String(cfg?.method ?? 'GET').toUpperCase(),
    url: String(cfg?.url ?? ''),
    status,
    debugId: typeof resHeaders['paypal-debug-id'] === 'string' ? (resHeaders['paypal-debug-id'] as string) : null,
    latencyMs: performance.now() - started,
    requestHeaders: pickHeaders(headerMap(cfg?.headers)),
    requestBody: typeof cfg?.data === 'string' ? parseJsonSafe(cfg.data) : (cfg?.data ?? null),
    responseBody: data ?? null,
    responseHeaders: resHeaders,
  }
}

function load(): ToolkitModule {
  if (loaded) return loaded
  // Load the toolkit and its axios through the same CommonJS require, so the interceptors land on the exact
  // axios instance the toolkit calls (an ESM `import 'axios'` would be a different module instance).
  const req = createRequire(import.meta.url)
  const entry = req.resolve('@paypal/agent-toolkit/ai-sdk')
  const mod = req(entry) as ToolkitModule
  const axios = createRequire(entry)('axios') as AxiosLike & { [INSTALLED_KEY]?: boolean }
  if (axios[INSTALLED_KEY]) {
    loaded = mod
    return mod
  }
  axios[INSTALLED_KEY] = true
  axios.interceptors.request.use((cfg) => {
    if (trace.getStore()) cfg[START] = performance.now()
    return cfg
  })
  axios.interceptors.response.use(
    (res) => {
      trace.getStore()?.push(traced(res.config, res.status, res.headers, res.data))
      return res
    },
    (err) => {
      const store = trace.getStore()
      if (store) store.push(traced(err?.config, err?.response?.status ?? 0, err?.response?.headers, err?.response?.data))
      return Promise.reject(err)
    },
  )
  loaded = mod
  return mod
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

const isOauth = (t: Traced) => pathOf(t.url) === '/v1/oauth2/token'

/**
 * Run one toolkit tool on a fresh instance. Records every HTTP call the tool made (its own OAuth fetch as
 * 'toolkit.oauth.token'), and returns PayPal's JSON body or throws a PayPalError built from the real response.
 */
export function toolkitCall(meta: Omit<CallMeta, 'method' | 'endpoint'> & { tool: ToolkitTool }, args: Record<string, unknown>): Promise<CallResult> {
  return paypalLimit(async () => {
    const { PayPalAgentToolkit } = load()
    const cfg = config().paypal
    if (cfg.environment !== 'sandbox') throw localError('NOT_SANDBOX', 'AnswerTab only talks to the PayPal sandbox')
    const context: Record<string, unknown> = { sandbox: true }
    if (meta.requestId) context.request_id = meta.requestId
    const toolkit = new PayPalAgentToolkit({ clientId: cfg.clientId, clientSecret: cfg.clientSecret, configuration: { actions: ACTIONS, context } })
    const tool = toolkit.getTools()[meta.tool] as { execute?: (a: unknown, o: unknown) => PromiseLike<unknown> } | undefined
    if (!tool?.execute) throw localError('TOOLKIT_ERROR', `Agent Toolkit has no ${meta.tool} tool`)

    const calls: Traced[] = []
    const started = performance.now()
    let out: unknown
    let thrown: unknown = null
    try {
      out = await trace.run(calls, () => tool.execute!(args, { toolCallId: `answertab-${meta.tool}`, messages: [] }))
    } catch (e) {
      thrown = e
    }
    const parsed = typeof out === 'string' ? parseJsonSafe(out) : out
    const main = [...calls].reverse().find((c) => !isOauth(c))

    let mainCall: LedgerCallView | null = null
    for (const c of calls) {
      const ok = c.status >= 200 && c.status < 300
      if (isOauth(c)) {
        await record({ op: 'toolkit.oauth.token', method: c.method, endpoint: '/v1/oauth2/token', requestId: c.requestHeaders['paypal-request-id'] ?? null, httpStatus: c.status, debugId: c.debugId, latencyMs: c.latencyMs, resourceStatus: ok ? 'issued' : 'failed', ctx: meta.ctx })
        continue
      }
      const r = ok ? (meta.resource ?? ((b: any) => ({ id: b?.id ?? null, status: b?.status ?? null })))(c.responseBody) : null
      const err = ok ? null : fromHttpResponse(c.status, c.responseBody, c.responseHeaders)
      const view = await record({
        op: meta.op, method: c.method, endpoint: pathOf(c.url), requestId: c.requestHeaders['paypal-request-id'] ?? null,
        httpStatus: c.status, resourceId: r?.id ?? null, resourceStatus: r?.status ?? err?.issue ?? err?.name ?? null,
        debugId: c.debugId ?? err?.debugId ?? null, latencyMs: c.latencyMs, ctx: meta.ctx,
        request: { ...meta.requestExtra, tool: meta.tool, headers: c.requestHeaders, body: c.requestBody },
        response: c.responseBody,
      })
      if (c === main) mainCall = view
    }

    const failed = thrown !== null || (typeof parsed === 'object' && parsed !== null && ('error' in parsed || (parsed as { ok?: unknown }).ok === false))
    if (!failed && main && mainCall && main.status >= 200 && main.status < 300) {
      return { httpStatus: main.status, body: main.responseBody ?? parsed, debugId: main.debugId, latencyMs: main.latencyMs, call: mainCall }
    }
    let err: PayPalError
    if (main && main.status >= 300) err = fromHttpResponse(main.status, main.responseBody, main.responseHeaders)
    else {
      const oauthFail = calls.find((c) => isOauth(c) && c.status >= 300)
      err = oauthFail ? fromHttpResponse(oauthFail.status, oauthFail.responseBody, oauthFail.responseHeaders) : toPayPalError(thrown ?? parsed)
    }
    if (!main) {
      // Nothing reached the PayPal API (token or setup failure): still leave a ledger row for the action.
      await record({ op: meta.op, method: 'POST', endpoint: `toolkit:${meta.tool}`, requestId: meta.requestId ?? null, httpStatus: err.httpStatus, resourceStatus: err.issue ?? err.name, debugId: err.debugId, latencyMs: performance.now() - started, ctx: meta.ctx, response: err.toJSON() })
    }
    throw err
  })
}
