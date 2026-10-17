// Deterministic PayPal-Request-Id values (ARCHITECTURE.md "PayPal-Request-Id scheme").
// The same logical write always sends the same ID, so a retry or replay never double-charges.
// After a 4xx the caller GETs the resource first, then retries with attempt n (suffix -a{n}).
import { localError } from './errors.js'

const SAFE = /^[A-Za-z0-9_-]+$/
/** PayPal accepts up to 108 characters for PayPal-Request-Id on Orders/Payments. */
const MAX_REQUEST_ID = 108
/** invoice_id: ^[A-Za-z0-9_-]{1,127}$ */
const MAX_INVOICE_ID = 127

function part(label: string, v: string): string {
  if (!SAFE.test(v)) throw localError('INVALID_ARGUMENT', `${label} has characters outside [A-Za-z0-9_-]: ${JSON.stringify(v)}`)
  return v
}

function build(prefix: string, parts: [string, string][], attempt = 0): string {
  if (!Number.isInteger(attempt) || attempt < 0) throw localError('INVALID_ARGUMENT', `attempt must be a non-negative integer, got ${attempt}`)
  const id = [prefix, ...parts.map(([label, v]) => part(label, v))].join('-')
  const full = attempt > 0 ? `${id}-a${attempt}` : id
  if (full.length > MAX_REQUEST_ID) throw localError('INVALID_ARGUMENT', `PayPal-Request-Id too long (${full.length}): ${full}`)
  return full
}

export const orderRequestId = (roomId: string, fanId: string, attempt = 0) => build('order', [['roomId', roomId], ['fanId', fanId]], attempt)
export const authRequestId = (roomId: string, fanId: string, attempt = 0) => build('auth', [['roomId', roomId], ['fanId', fanId]], attempt)
export const settleRequestId = (roomId: string, fanId: string, attempt = 0) => build('settle', [['roomId', roomId], ['fanId', fanId]], attempt)
export const voidRequestId = (roomId: string, fanId: string, attempt = 0) => build('void', [['roomId', roomId], ['fanId', fanId]], attempt)
export const refundRequestId = (contestId: string, attempt = 0) => build('refund', [['contestId', contestId]], attempt)

/** Payouts: also the sender_batch_id. The attempt number is part of the base ID (payout-{room}-{attempt}). */
export function payoutRequestId(roomId: string, attempt: number): string {
  if (!Number.isInteger(attempt) || attempt < 0) throw localError('INVALID_ARGUMENT', `payout attempt must be a non-negative integer, got ${attempt}`)
  return build('payout', [['roomId', roomId], ['attempt', String(attempt)]])
}

/** invoice_id for the order and its capture: tab-{room}-{fan}. */
export function invoiceId(roomId: string, fanId: string): string {
  const id = `tab-${part('roomId', roomId)}-${part('fanId', fanId)}`
  if (id.length > MAX_INVOICE_ID) throw localError('INVALID_ARGUMENT', `invoice_id too long (${id.length})`)
  return id
}

/** custom_id on the order: room-fan. */
export const customId = (roomId: string, fanId: string) => `${part('roomId', roomId)}-${part('fanId', fanId)}`
