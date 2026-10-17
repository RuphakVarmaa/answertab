// PayPal transport: one OAuth token cache shared by the Server SDK and typed fetch, the concurrency
// limiter, ledger recording and error mapping. Feature modules call sdkCall()/restCall() only.
import { Client, Environment, OrdersController, PaymentsController, ResponseValidationError } from '@paypal/paypal-server-sdk'
import type { ApiResponse } from '@paypal/paypal-server-sdk'
import { config } from '../config.js'
import { fromHttpResponse, localError, parseJsonSafe, toPayPalError, PayPalError } from './errors.js'
import { record, type LedgerContext } from './ledger.js'
import { paypalLimit, type Limiter } from './limiter.js'
import { pickHeaders } from './redact.js'
import type { LedgerCallView } from '../../shared/types.js'

export const PREFER_REPRESENTATION = 'return=representation'
const TIMEOUT_MS = 30_000
/** Refresh this long before PayPal's expires_in, so a token never expires mid-request. */
const REFRESH_MARGIN_MS = 5 * 60_000

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

export interface CallMeta {
  op: string
  method: HttpMethod
  endpoint: string
  requestId?: string | null
  ctx?: LedgerContext
  /** Picks the ledger's resource id/status from a parsed success body. Default: body.id / body.status. */
  resource?: (body: any) => { id?: string | null; status?: string | null }
  /** Extra request facts to keep in the ledger (e.g. path params needed for replay). */
  requestExtra?: Record<string, unknown>
  /** Limiter for this call (default: the shared PayPal limiter). Webhook verification uses its own. */
  limit?: Limiter
  /** Keep the request body out of the ledger (webhook verification carries untrusted event bodies). */
  omitRequestBody?: boolean
}

export interface CallResult<T = any> {
  httpStatus: number
  body: T
  debugId: string | null
  latencyMs: number
  call: LedgerCallView
}

function apiBase(): string {
  const cfg = config()
  if (cfg.paypal.environment !== 'sandbox' || !cfg.paypal.apiBase.includes('sandbox')) {
    throw localError('NOT_SANDBOX', 'AnswerTab only talks to the PayPal sandbox')
  }
  return cfg.paypal.apiBase
}

// ---------- OAuth token cache ----------

interface CachedToken {
  value: string
  refreshAt: number
}
let token: CachedToken | null = null
let pendingToken: Promise<CachedToken> | null = null

async function fetchToken(): Promise<CachedToken> {
  const cfg = config().paypal
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')
  const started = performance.now()
  let res: Response
  try {
    res = await fetch(`${apiBase()}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    const err = toPayPalError(e)
    await record({ op: 'oauth.token', method: 'POST', endpoint: '/v1/oauth2/token', requestId: null, httpStatus: 0, latencyMs: performance.now() - started, resourceStatus: err.name })
    throw err
  }
  const body = parseJsonSafe(await res.text()) as Record<string, unknown> | null
  const debugId = res.headers.get('paypal-debug-id')
  const latencyMs = performance.now() - started
  const accessToken = typeof body?.access_token === 'string' ? body.access_token : null
  if (!res.ok || !accessToken) {
    const err = res.ok ? localError('INVALID_RESPONSE', 'OAuth response had no access_token') : fromHttpResponse(res.status, body, Object.fromEntries(res.headers))
    await record({ op: 'oauth.token', method: 'POST', endpoint: '/v1/oauth2/token', requestId: null, httpStatus: res.status, debugId, latencyMs, resourceStatus: err.name, response: { error: body?.error ?? null, error_description: body?.error_description ?? null } })
    throw err
  }
  const expiresInS = typeof body?.expires_in === 'number' ? body.expires_in : 3600
  const scopes = typeof body?.scope === 'string' ? body.scope.split(' ').length : null
  // The token itself never reaches the ledger.
  await record({ op: 'oauth.token', method: 'POST', endpoint: '/v1/oauth2/token', requestId: null, httpStatus: res.status, debugId, latencyMs, resourceStatus: 'issued', response: { token_type: body?.token_type ?? null, expires_in: expiresInS, scope_count: scopes } })
  return { value: accessToken, refreshAt: Date.now() + Math.max(60_000, expiresInS * 1000 - REFRESH_MARGIN_MS) }
}

async function tokenEntry(): Promise<CachedToken> {
  if (token && Date.now() < token.refreshAt) return token
  if (!pendingToken) {
    pendingToken = fetchToken()
      .then((t) => (token = t))
      .finally(() => {
        pendingToken = null
      })
  }
  return pendingToken
}

/** A valid sandbox access token (cached; refreshed on expiry or after a 401). */
export async function accessToken(): Promise<string> {
  return (await tokenEntry()).value
}

function invalidateToken(): void {
  token = null
  sdkClients = null // the SDK caches its own copy of the token; rebuild it
}

// ---------- Server SDK ----------

export interface SdkClients {
  orders: OrdersController
  payments: PaymentsController
}
let sdkClients: SdkClients | null = null

export function sdk(): SdkClients {
  if (!sdkClients) {
    const cfg = config().paypal
    apiBase()
    const client = new Client({
      environment: Environment.Sandbox,
      timeout: TIMEOUT_MS,
      clientCredentialsAuthCredentials: {
        oAuthClientId: cfg.clientId,
        oAuthClientSecret: cfg.clientSecret,
        // Share our cache so SDK and fetch calls use one token and one refresh path.
        oAuthTokenProvider: async () => {
          const t = await tokenEntry()
          return { accessToken: t.value, tokenType: 'Bearer', expiry: BigInt(Math.floor(t.refreshAt / 1000)) }
        },
      },
    })
    sdkClients = { orders: new OrdersController(client), payments: new PaymentsController(client) }
  }
  return sdkClients
}

/** Tests only. */
export function resetPayPalClientForTests(): void {
  token = null
  pendingToken = null
  sdkClients = null
}

function defaultResource(body: any): { id?: string | null; status?: string | null } {
  return { id: typeof body?.id === 'string' ? body.id : null, status: typeof body?.status === 'string' ? body.status : null }
}

function wireRequest(req: { headers?: Record<string, string>; body?: unknown } | undefined, extra?: Record<string, unknown>) {
  const b = req?.body as { type?: string; content?: unknown } | undefined
  const body = b?.type === 'text' ? parseJsonSafe(b.content) : null
  return { ...extra, headers: pickHeaders(req?.headers), body }
}

/** Shared success/failure bookkeeping for one HTTP exchange. */
async function finish(meta: CallMeta, status: number, headers: Record<string, unknown>, body: unknown, request: unknown, latencyMs: number): Promise<CallResult> {
  const debugId = typeof headers['paypal-debug-id'] === 'string' ? (headers['paypal-debug-id'] as string) : null
  if (status >= 200 && status < 300) {
    const r = (meta.resource ?? defaultResource)(body)
    const call = await record({
      op: meta.op, method: meta.method, endpoint: meta.endpoint, requestId: meta.requestId ?? null, httpStatus: status,
      resourceId: r.id ?? null, resourceStatus: r.status ?? null, debugId, latencyMs, ctx: meta.ctx, request, response: body,
    })
    return { httpStatus: status, body, debugId, latencyMs, call }
  }
  const err = fromHttpResponse(status, body, headers)
  await recordError(meta, err, request, body, latencyMs)
  throw err
}

async function recordError(meta: CallMeta, err: PayPalError, request: unknown, response: unknown, latencyMs: number): Promise<void> {
  await record({
    op: meta.op, method: meta.method, endpoint: meta.endpoint, requestId: meta.requestId ?? null, httpStatus: err.httpStatus,
    resourceId: null, resourceStatus: err.issue ?? err.name, debugId: err.debugId, latencyMs, ctx: meta.ctx, request,
    response: response ?? err.toJSON(),
  })
}

/**
 * One Server SDK call: limited, timed, recorded, errors mapped. The raw JSON body (snake_case, exactly as PayPal
 * sent it) is returned instead of the SDK's camelCase model, so parsers match the fixtures and the ledger.
 * A 401 refreshes the token and retries once (safe: nothing was processed, and writes carry PayPal-Request-Id).
 */
export function sdkCall(meta: CallMeta, fn: (c: SdkClients) => Promise<ApiResponse<unknown>>): Promise<CallResult> {
  return paypalLimit(async () => {
    for (let attempt = 0; ; attempt++) {
      const started = performance.now()
      try {
        const res = await fn(sdk())
        return await finish(meta, res.statusCode, res.headers, parseJsonSafe(res.body), wireRequest(res.request, meta.requestExtra), performance.now() - started)
      } catch (e) {
        if (e instanceof PayPalError) throw e // already recorded by finish()
        const latencyMs = performance.now() - started
        const ctxObj = e as { statusCode?: number; headers?: Record<string, unknown>; body?: unknown; request?: { headers?: Record<string, string>; body?: unknown } }
        const request = wireRequest(ctxObj?.request, meta.requestExtra)
        // The call succeeded but the SDK's schema check failed: trust PayPal's body, not the SDK model.
        if (e instanceof ResponseValidationError && e.statusCode >= 200 && e.statusCode < 300) {
          return await finish(meta, e.statusCode, e.headers, parseJsonSafe(e.body), request, latencyMs)
        }
        const err = toPayPalError(e)
        if (err.httpStatus === 401 && attempt === 0) {
          await recordError(meta, err, request, parseJsonSafe(ctxObj?.body), latencyMs)
          invalidateToken()
          continue
        }
        await recordError(meta, err, request, parseJsonSafe(ctxObj?.body), latencyMs)
        throw err
      }
    }
  })
}

export interface RestRequest {
  path: string
  query?: Record<string, string | number | boolean | undefined>
  /** JSON-serialized for you. */
  body?: unknown
  /** Sent verbatim (e.g. a webhook body spliced in byte-for-byte). Takes precedence over `body`. */
  rawBody?: string
  headers?: Record<string, string>
}

/** One typed-fetch call (Payouts, webhooks, balances). Same limiter, ledger, error mapping and 401 retry as sdkCall. */
export function restCall<T = any>(meta: CallMeta, req: RestRequest): Promise<CallResult<T>> {
  return (meta.limit ?? paypalLimit)(async () => {
    const url = new URL(apiBase() + req.path)
    for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v))
    const payload = req.rawBody ?? (req.body === undefined ? undefined : JSON.stringify(req.body))
    const sentHeaders: Record<string, string> = {
      Accept: 'application/json',
      ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(meta.requestId ? { 'PayPal-Request-Id': meta.requestId } : {}),
      ...req.headers,
    }
    const request = { ...meta.requestExtra, headers: pickHeaders(sentHeaders), body: payload === undefined || meta.omitRequestBody ? null : parseJsonSafe(payload) }
    for (let attempt = 0; ; attempt++) {
      const started = performance.now()
      let res: Response
      try {
        const bearer = await accessToken()
        res = await fetch(url, {
          method: meta.method,
          headers: { ...sentHeaders, Authorization: `Bearer ${bearer}` },
          body: payload,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
      } catch (e) {
        const err = toPayPalError(e)
        if (!(e instanceof PayPalError)) await recordError(meta, err, request, undefined, performance.now() - started)
        throw err
      }
      const text = await res.text()
      const latencyMs = performance.now() - started
      const headers = Object.fromEntries(res.headers)
      const body = parseJsonSafe(text)
      if (res.status === 401 && attempt === 0) {
        await recordError(meta, fromHttpResponse(401, body, headers), request, body, latencyMs)
        invalidateToken()
        continue
      }
      return (await finish(meta, res.status, headers, body, request, latencyMs)) as CallResult<T>
    }
  })
}
