// Payouts v1 (creator payout after the contest window) and Reporting balances, over typed fetch.
// A reused sender_batch_id is rejected, not replayed (HTTP 400 USER_BUSINESS_ERROR, field SENDER_BATCH_ID, even
// with the same PayPal-Request-Id). So payout_batch_id from the first response is written to the payouts row, and
// a duplicate is answered from that stored id, or from the original batch linked in the rejection's details[].link.
import { assertCents, toAmount } from '../../shared/money.js'
import { db } from '../db/db.js'
import { restCall } from './client.js'
import { localError, PayPalError } from './errors.js'
import type { LedgerContext } from './ledger.js'
import { maskEmail, redact } from './redact.js'
import { payoutRequestId } from './requestIds.js'

type Obj = Record<string, any>

/** Signed PayPal amount ("-1.50", "5000.00") to cents; null if malformed. Balances can be negative. */
export function signedCents(v: unknown): number | null {
  if (typeof v !== 'string' || !/^-?\d+(\.\d{1,2})?$/.test(v)) return null
  const neg = v.startsWith('-')
  const [whole, frac = ''] = (neg ? v.slice(1) : v).split('.')
  const c = Number(whole) * 100 + Number(frac.padEnd(2, '0'))
  return neg ? -c : c
}

export interface ParsedPayoutBatch {
  payoutBatchId: string
  senderBatchId: string | null
  batchStatus: string
  amountCents: number | null
  feeCents: number | null
  items: {
    payoutItemId: string | null
    transactionId: string | null
    transactionStatus: string | null
    senderItemId: string | null
    amountCents: number | null
    feeCents: number | null
    receiver: string | null
    errorName: string | null
  }[]
}

export function parsePayoutBatch(raw: unknown): ParsedPayoutBatch {
  const r = (raw ?? {}) as Obj
  const h = (r.batch_header ?? {}) as Obj
  return {
    payoutBatchId: String(h.payout_batch_id ?? ''),
    senderBatchId: h.sender_batch_header?.sender_batch_id ?? null,
    batchStatus: String(h.batch_status ?? ''),
    amountCents: signedCents(h.amount?.value),
    feeCents: signedCents(h.fees?.value),
    items: ((r.items ?? []) as Obj[]).map((i) => ({
      payoutItemId: i.payout_item_id ?? null,
      transactionId: i.transaction_id ?? null,
      transactionStatus: i.transaction_status ?? null,
      senderItemId: i.payout_item?.sender_item_id ?? null,
      amountCents: signedCents(i.payout_item?.amount?.value),
      feeCents: signedCents(i.payout_item_fee?.value),
      receiver: typeof i.payout_item?.receiver === 'string' ? maskEmail(i.payout_item.receiver) : null,
      errorName: i.errors?.name ?? null,
    })),
  }
}

const batchResource = (b: unknown) => {
  const p = parsePayoutBatch(b)
  return { id: p.payoutBatchId || null, status: p.batchStatus || null }
}

/** PayPal's answer to a reused sender_batch_id (verified in sandbox 2026-10-16). */
export function isDuplicatePayoutBatch(e: unknown): boolean {
  return (
    e instanceof PayPalError &&
    e.httpStatus === 400 &&
    e.details.some((d) => d.field === 'SENDER_BATCH_ID' || /sender_batch_id already exists/i.test(d.issue))
  )
}

async function storedBatchId(senderBatchId: string): Promise<string | null> {
  try {
    const rows = await db().query<{ payout_batch_id: string | null }>(`SELECT payout_batch_id FROM payouts WHERE sender_batch_id = $1`, [senderBatchId])
    return rows[0]?.payout_batch_id ?? null
  } catch {
    return null
  }
}

/** The original batch linked from a duplicate rejection (details[].link[].href = .../v1/payments/payouts/{id}). */
export function linkedBatchId(e: PayPalError): string | null {
  for (const l of e.links) {
    const m = /\/v1\/payments\/payouts\/([A-Za-z0-9]+)(?:$|[/?])/.exec(l.href)
    if (m?.[1]) return m[1]
  }
  return null
}

async function storeBatchId(senderBatchId: string, payoutBatchId: string, batchStatus: string | null): Promise<void> {
  try {
    await db().query(
      `UPDATE payouts SET payout_batch_id = COALESCE(payout_batch_id, $2), batch_status = COALESCE($3, batch_status), updated_at = now()
       WHERE sender_batch_id = $1`,
      [senderBatchId, payoutBatchId, batchStatus],
    )
  } catch (e) {
    console.warn(`[paypal-payouts] could not store payout_batch_id: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`)
  }
}

export async function createPayout(p: { roomId: string; attempt: number; receiverEmail: string; amountCents: number; note: string }): Promise<{
  payoutBatchId: string
  batchStatus: string
  senderBatchId: string
  recovered: boolean
}> {
  assertCents(p.amountCents, 'amountCents')
  if (p.amountCents <= 0) throw localError('INVALID_ARGUMENT', 'payout amount must be > 0')
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.receiverEmail)) throw localError('INVALID_ARGUMENT', 'receiverEmail is not an email address')
  const senderBatchId = payoutRequestId(p.roomId, p.attempt)
  const ctx: LedgerContext = { roomId: p.roomId }
  const body = {
    sender_batch_header: {
      sender_batch_id: senderBatchId,
      email_subject: 'Your AnswerTab payout',
      email_message: p.note.slice(0, 1000),
    },
    items: [
      {
        recipient_type: 'EMAIL',
        amount: { value: toAmount(p.amountCents), currency: 'USD' },
        receiver: p.receiverEmail,
        note: p.note.slice(0, 4000),
        sender_item_id: `${senderBatchId}-1`,
      },
    ],
  }
  try {
    const res = await restCall(
      { op: 'payouts.create', method: 'POST', endpoint: '/v1/payments/payouts', requestId: senderBatchId, ctx, resource: batchResource },
      { path: '/v1/payments/payouts', body },
    )
    const parsed = parsePayoutBatch(res.body)
    if (!parsed.payoutBatchId) throw new PayPalError({ name: 'INVALID_RESPONSE', message: 'payout response had no payout_batch_id', httpStatus: res.httpStatus, debugId: res.debugId })
    await storeBatchId(senderBatchId, parsed.payoutBatchId, parsed.batchStatus || null)
    return { payoutBatchId: parsed.payoutBatchId, batchStatus: parsed.batchStatus, senderBatchId, recovered: false }
  } catch (e) {
    if (!isDuplicatePayoutBatch(e)) throw e
    // This attempt already went through earlier (response lost, or a retry): answer with the original batch.
    const original = (await storedBatchId(senderBatchId)) ?? linkedBatchId(e as PayPalError)
    if (!original) throw e
    const batch = await getPayoutBatch(original, ctx)
    if (batch.senderBatchId !== null && batch.senderBatchId !== senderBatchId) throw e
    await storeBatchId(senderBatchId, batch.payoutBatchId, batch.batchStatus || null)
    return { payoutBatchId: batch.payoutBatchId, batchStatus: batch.batchStatus, senderBatchId, recovered: true }
  }
}

export async function getPayoutBatch(id: string, ctx?: LedgerContext): Promise<ParsedPayoutBatch & { raw: unknown }> {
  const res = await restCall({ op: 'payouts.get', method: 'GET', endpoint: `/v1/payments/payouts/${id}`, ctx, resource: batchResource }, { path: `/v1/payments/payouts/${encodeURIComponent(id)}` })
  return { ...parsePayoutBatch(res.body), raw: redact(res.body) }
}

export interface Balance {
  currency: string
  totalCents: number | null
  availableCents: number | null
  withheldCents: number | null
  primary: boolean
}

export async function getBalances(): Promise<{ balances: Balance[]; asOf: string | null; raw: unknown }> {
  const res = await restCall(
    { op: 'balances.get', method: 'GET', endpoint: '/v1/reporting/balances', resource: (b) => ({ id: null, status: Array.isArray(b?.balances) ? `${b.balances.length} currencies` : null }) },
    { path: '/v1/reporting/balances' },
  )
  const r = (res.body ?? {}) as Obj
  const balances: Balance[] = ((r.balances ?? []) as Obj[]).map((b) => ({
    currency: String(b.currency ?? b.total_balance?.currency_code ?? ''),
    totalCents: signedCents(b.total_balance?.value),
    availableCents: signedCents(b.available_balance?.value),
    withheldCents: signedCents(b.withheld_balance?.value),
    primary: b.primary === true,
  }))
  return { balances, asOf: r.as_of_time ?? null, raw: redact(res.body) }
}
