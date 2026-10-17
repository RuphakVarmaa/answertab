// Contest refunds: Agent Toolkit create_refund with an explicit amount, then get_refund for PayPal's own
// seller_payable_breakdown. If PayPal rejects the toolkit's request shape (it posts every parameter, capture_id
// included, as the body), the same refund goes through the Server SDK with the same PayPal-Request-Id.
import { assertCents, parseAmount, toAmount } from '../../shared/money.js'
import { PREFER_REPRESENTATION, sdkCall, type CallResult } from './client.js'
import { localError, PayPalError } from './errors.js'
import type { LedgerContext } from './ledger.js'
import { redact } from './redact.js'
import { refundRequestId } from './requestIds.js'
import { toolkitCall } from './toolkit.js'
import { clip, NOTE_TO_PAYER_MAX } from './payments.js'

type Obj = Record<string, any>

export type RefundPath = 'toolkit' | 'sdk-fallback'

export interface ParsedRefund {
  refundId: string
  status: string
  grossCents: number
  /** The fee PayPal returned to the merchant (usually 0: PayPal keeps the original capture fee). */
  feeReturnedCents: number
  netCents: number
  captureId: string | null
}

function cents(v: unknown): number | null {
  if (typeof v !== 'string') return null
  try {
    return parseAmount(v)
  } catch {
    return null
  }
}

export function parseRefund(raw: unknown): ParsedRefund {
  const r = (raw ?? {}) as Obj
  const b = (r.seller_payable_breakdown ?? {}) as Obj
  const gross = cents(b.gross_amount?.value) ?? cents(r.amount?.value) ?? 0
  const fee = cents(b.paypal_fee?.value) ?? 0
  const up = ((r.links ?? []) as Obj[]).find((l) => l.rel === 'up' && /\/captures\//.test(String(l.href)))
  return {
    refundId: String(r.id ?? ''),
    status: String(r.status ?? ''),
    grossCents: gross,
    feeReturnedCents: fee,
    netCents: cents(b.net_amount?.value) ?? gross - fee,
    captureId: up ? (String(up.href).split('/captures/')[1]?.split('/')[0] ?? null) : null,
  }
}

/** 400s (request shape) and transport failures may be toolkit-specific; business 4xx (422) are real answers. */
function toolkitMayBeAtFault(e: PayPalError): boolean {
  return e.httpStatus === 400 || e.httpStatus === 0
}

export async function refundShare(p: { contestId: string; captureId: string; amountCents: number; noteToPayer: string }): Promise<
  ParsedRefund & { path: RefundPath; raw: unknown }
> {
  assertCents(p.amountCents, 'amountCents')
  if (p.amountCents <= 0) throw localError('INVALID_ARGUMENT', 'refund amount must be > 0')
  const requestId = refundRequestId(p.contestId)
  const ctx: LedgerContext = { contestId: p.contestId }
  const amount = { currency_code: 'USD', value: toAmount(p.amountCents) }
  const note = clip(p.noteToPayer, NOTE_TO_PAYER_MAX)

  let created: CallResult
  let path: RefundPath = 'toolkit'
  try {
    created = await toolkitCall(
      { op: 'refunds.create:toolkit', tool: 'create_refund', requestId, ctx },
      { capture_id: p.captureId, amount, note_to_payer: note },
    )
  } catch (e) {
    if (!(e instanceof PayPalError) || !toolkitMayBeAtFault(e)) throw e
    path = 'sdk-fallback'
    // Same request id: if the first attempt did land, PayPal replays it instead of refunding twice.
    created = await sdkCall(
      { op: 'refunds.create:sdk-fallback', method: 'POST', endpoint: `/v2/payments/captures/${p.captureId}/refund`, requestId, ctx },
      (c) =>
        c.payments.refundCapturedPayment({
          captureId: p.captureId, paypalRequestId: requestId, prefer: PREFER_REPRESENTATION,
          body: { amount: { currencyCode: 'USD', value: amount.value }, noteToPayer: note },
        }),
    )
  }
  const refundId = parseRefund(created.body).refundId
  if (!refundId) throw new PayPalError({ name: 'INVALID_RESPONSE', message: 'refund response had no id', httpStatus: created.httpStatus, debugId: created.debugId })

  // The toolkit sends no Prefer header, so its create response is minimal; read the breakdown back.
  const full = await getRefund(refundId, ctx).catch(() => null)
  const parsed = full ?? { ...parseRefund(created.body), raw: redact(created.body) }
  return { ...parsed, path }
}

/** GET /v2/payments/refunds/{id} via the toolkit's get_refund, falling back to the Server SDK. */
export async function getRefund(id: string, ctx?: LedgerContext): Promise<ParsedRefund & { raw: unknown }> {
  let res: CallResult
  try {
    res = await toolkitCall({ op: 'refunds.get:toolkit', tool: 'get_refund', ctx }, { refund_id: id })
  } catch (e) {
    if (!(e instanceof PayPalError) || !toolkitMayBeAtFault(e)) throw e
    res = await sdkCall({ op: 'refunds.get:sdk-fallback', method: 'GET', endpoint: `/v2/payments/refunds/${id}`, ctx }, (c) => c.payments.getRefund({ refundId: id }))
  }
  return { ...parseRefund(res.body), raw: redact(res.body) }
}
