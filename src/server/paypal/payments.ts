// Payments v2: settle a tab (one final capture), void it, read authorizations and captures, replay a capture.
import type { CaptureRequest } from '@paypal/paypal-server-sdk'
import { assertCents, parseAmount, toAmount } from '../../shared/money.js'
import { PREFER_REPRESENTATION, sdkCall } from './client.js'
import { localError, PayPalError } from './errors.js'
import { getLedgerCall, type LedgerContext } from './ledger.js'
import { redact } from './redact.js'
import { invoiceId, settleRequestId, voidRequestId } from './requestIds.js'

type Obj = Record<string, any>

export const NOTE_TO_PAYER_MAX = 255

function cents(v: unknown): number | null {
  if (typeof v !== 'string') return null
  try {
    return parseAmount(v)
  } catch {
    return null
  }
}

/** Trim to `max` UTF-16 units without splitting a surrogate pair. */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s
  let out = s.slice(0, max)
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1)
  return out
}

/** PayPal-Mock-Response header from either a bare code (AUTHORIZATION_EXPIRED) or a full JSON value. */
export function mockHeader(mock: string | undefined): string | undefined {
  if (!mock) return undefined
  if (mock.trim().startsWith('{')) return mock
  if (!/^[A-Z0-9_]+$/.test(mock)) throw localError('INVALID_ARGUMENT', `bad mock code: ${mock}`)
  return JSON.stringify({ mock_application_codes: mock })
}

export interface ParsedCapture {
  captureId: string
  status: string
  /** PENDING captures carry a reason (e.g. PENDING_REVIEW); never show them as paid. */
  statusReason: string | null
  grossCents: number
  /** null when PayPal has not reported a breakdown (e.g. some PENDING captures). */
  feeCents: number | null
  netCents: number | null
  finalCapture: boolean | null
  invoiceId: string | null
  authorizationId: string | null
}

export function parseCapture(raw: unknown): ParsedCapture {
  const c = (raw ?? {}) as Obj
  const b = (c.seller_receivable_breakdown ?? {}) as Obj
  const up = ((c.links ?? []) as Obj[]).find((l) => l.rel === 'up' && /\/authorizations\//.test(String(l.href)))
  return {
    captureId: String(c.id ?? ''),
    status: String(c.status ?? ''),
    statusReason: c.status_details?.reason ?? null,
    grossCents: cents(b.gross_amount?.value) ?? cents(c.amount?.value) ?? 0,
    feeCents: cents(b.paypal_fee?.value),
    netCents: cents(b.net_amount?.value),
    finalCapture: typeof c.final_capture === 'boolean' ? c.final_capture : null,
    invoiceId: c.invoice_id ?? null,
    authorizationId: c.supplementary_data?.related_ids?.authorization_id ?? (up ? String(up.href).split('/authorizations/')[1]?.split('/')[0] ?? null : null),
  }
}

export interface ParsedAuthorization {
  authorizationId: string
  status: string
  amountCents: number
  expiresAt: string | null
  orderId: string | null
}

export function parseAuthorization(raw: unknown): ParsedAuthorization {
  const a = (raw ?? {}) as Obj
  return {
    authorizationId: String(a.id ?? ''),
    status: String(a.status ?? ''),
    amountCents: cents(a.amount?.value) ?? 0,
    expiresAt: a.expiration_time ?? null,
    orderId: a.supplementary_data?.related_ids?.order_id ?? null,
  }
}

/** Capture request in the SDK's camelCase model. Exported for tests. */
export function buildCapture(p: { roomId: string; fanId: string; amountCents: number; noteToPayer: string }): CaptureRequest {
  assertCents(p.amountCents, 'amountCents')
  if (p.amountCents <= 0) throw localError('INVALID_ARGUMENT', 'a capture must be > 0; void the tab instead')
  return {
    amount: { currencyCode: 'USD', value: toAmount(p.amountCents) },
    finalCapture: true,
    noteToPayer: clip(p.noteToPayer, NOTE_TO_PAYER_MAX),
    invoiceId: invoiceId(p.roomId, p.fanId),
  }
}

/** Wire (snake_case) capture body back into the SDK model, for replay. */
function captureFromWire(w: Obj): CaptureRequest {
  const out: CaptureRequest = {}
  if (w.amount) out.amount = { currencyCode: String(w.amount.currency_code), value: String(w.amount.value) }
  if (typeof w.final_capture === 'boolean') out.finalCapture = w.final_capture
  if (typeof w.note_to_payer === 'string') out.noteToPayer = w.note_to_payer
  if (typeof w.invoice_id === 'string') out.invoiceId = w.invoice_id
  if (typeof w.soft_descriptor === 'string') out.softDescriptor = w.soft_descriptor
  return out
}

function captureResource(body: unknown) {
  const c = parseCapture(body)
  return { id: c.captureId || null, status: c.status || null }
}

/**
 * Settle a tab: one capture with final_capture true (PayPal releases the rest of the hold).
 * `mock` sends PayPal-Mock-Response (negative tests), e.g. 'AUTHORIZATION_EXPIRED'.
 */
export async function captureTab(p: {
  roomId: string
  fanId: string
  authorizationId: string
  amountCents: number
  noteToPayer: string
  mock?: string
  attempt?: number
}): Promise<ParsedCapture & { raw: unknown; ledgerCallId: string }> {
  const body = buildCapture(p)
  const requestId = settleRequestId(p.roomId, p.fanId, p.attempt ?? 0)
  const paypalMockResponse = mockHeader(p.mock)
  const res = await sdkCall(
    {
      op: 'payments.capture', method: 'POST', endpoint: `/v2/payments/authorizations/${p.authorizationId}/capture`, requestId,
      ctx: { roomId: p.roomId, fanId: p.fanId }, resource: captureResource,
      requestExtra: { authorization_id: p.authorizationId, fan_id: p.fanId },
    },
    (c) =>
      c.payments.captureAuthorizedPayment({
        authorizationId: p.authorizationId, body, paypalRequestId: requestId, prefer: PREFER_REPRESENTATION,
        ...(paypalMockResponse ? { paypalMockResponse } : {}),
      }),
  )
  return { ...parseCapture(res.body), raw: redact(res.body), ledgerCallId: res.call.id }
}

/** Release a whole hold (nothing answered, or the approve deadline passed). */
export async function voidTab(p: { roomId: string; fanId: string; authorizationId: string; attempt?: number }): Promise<{ status: string; raw: unknown }> {
  const requestId = voidRequestId(p.roomId, p.fanId, p.attempt ?? 0)
  const res = await sdkCall(
    {
      op: 'payments.void', method: 'POST', endpoint: `/v2/payments/authorizations/${p.authorizationId}/void`, requestId,
      ctx: { roomId: p.roomId, fanId: p.fanId },
      resource: (b) => ({ id: b?.id ?? p.authorizationId, status: b?.status ?? 'VOIDED' }),
    },
    (c) => c.payments.voidPayment({ authorizationId: p.authorizationId, paypalRequestId: requestId, prefer: PREFER_REPRESENTATION }),
  )
  // 204 No Content (no representation) also means voided.
  const status = typeof (res.body as Obj | null)?.status === 'string' ? String((res.body as Obj).status) : 'VOIDED'
  return { status, raw: redact(res.body) }
}

export async function getAuthorization(id: string, ctx?: LedgerContext): Promise<ParsedAuthorization & { raw: unknown }> {
  const res = await sdkCall(
    { op: 'payments.authorization.get', method: 'GET', endpoint: `/v2/payments/authorizations/${id}`, ctx },
    (c) => c.payments.getAuthorizedPayment({ authorizationId: id }),
  )
  return { ...parseAuthorization(res.body), raw: redact(res.body) }
}

export async function getCapture(id: string, ctx?: LedgerContext): Promise<ParsedCapture & { raw: unknown }> {
  const res = await sdkCall(
    { op: 'payments.capture.get', method: 'GET', endpoint: `/v2/payments/captures/${id}`, ctx, resource: captureResource },
    (c) => c.payments.getCapturedPayment({ captureId: id }),
  )
  return { ...parseCapture(res.body), raw: redact(res.body) }
}

/**
 * Resend a recorded capture with its original PayPal-Request-Id and body. PayPal should answer with the
 * original capture (HTTP 200) instead of charging again.
 */
export async function replayCapture(callId: string): Promise<{ captureId: string; sameAsOriginal: boolean; originalCaptureId: string; httpStatus: number }> {
  let row
  try {
    row = await getLedgerCall(callId)
  } catch (e) {
    throw localError('LEDGER_UNAVAILABLE', `could not read ledger call: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!row) throw localError('LEDGER_CALL_NOT_FOUND', `no ledger call ${callId}`)
  const req = (row.request_redacted ?? {}) as Obj
  const authorizationId = typeof req.authorization_id === 'string' ? req.authorization_id : null
  if (!row.op.startsWith('payments.capture') || row.op === 'payments.capture.get' || !authorizationId || !row.request_id || !req.body) {
    throw localError('NOT_REPLAYABLE', `ledger call ${callId} is not a capture`)
  }
  if (row.http_status < 200 || row.http_status >= 300 || !row.resource_id) {
    throw localError('NOT_REPLAYABLE', `ledger call ${callId} did not create a capture (HTTP ${row.http_status})`)
  }
  const requestId = row.request_id
  const body = captureFromWire(req.body as Obj)
  const res = await sdkCall(
    {
      op: 'payments.capture.replay', method: 'POST', endpoint: `/v2/payments/authorizations/${authorizationId}/capture`, requestId,
      ctx: { roomId: row.room_id, tabId: row.tab_id }, resource: captureResource,
      requestExtra: { authorization_id: authorizationId, replay_of: callId },
    },
    (c) => c.payments.captureAuthorizedPayment({ authorizationId, body, paypalRequestId: requestId, prefer: PREFER_REPRESENTATION }),
  )
  const captureId = parseCapture(res.body).captureId
  if (!captureId) throw new PayPalError({ name: 'INVALID_RESPONSE', message: 'replay returned no capture id', httpStatus: res.httpStatus, debugId: res.debugId })
  return { captureId, sameAsOriginal: captureId === row.resource_id, originalCaptureId: row.resource_id, httpStatus: res.httpStatus }
}
