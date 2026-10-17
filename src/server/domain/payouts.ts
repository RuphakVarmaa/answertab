// Creator payout after the contest window: amount from PayPal's own numbers (capture nets, refund nets) minus the
// platform fee, sent with Payouts to the fixed demo creator account, then polled until terminal.
import type { PayoutState, PayoutView } from '../../shared/types.js'
import { formatCents, payoutAmount } from '../../shared/money.js'
import { config } from '../config.js'
import { db } from '../db/db.js'
import { newId } from '../ids.js'
import { createPayout, getCapture, getPayoutBatch, getRefund, isDuplicatePayoutBatch, isPayPalError, requestIds } from '../paypal/index.js'
import { CREATOR, emit } from './bus.js'
import { now, nowDate } from './clock.js'
import { DomainError, conflict, forbidden } from './errors.js'
import { scheduleJob, type JobResult } from './jobQueue.js'
import { payoutView, type ContestRow, type PayoutRow, type RoomRow, type TabRow } from './rows.js'
import { COMPLETED_CAPTURE } from './settle.js'
import { recoverStaleContests } from './contests.js'
import { emitRoomState, requireRoom } from './views.js'

/** Poll every 10 s for the first 15 minutes, then every 10 minutes until 24 h after the payout was sent. */
const POLL_EVERY_MS = 10_000
const FAST_POLLS = 90
const SLOW_POLL_MS = 10 * 60_000
const POLL_FOR_MS = 24 * 3600_000
const CONTEST_RECHECK_MS = 60_000
/** A capture still PENDING at PayPal holds the payout back until it completes. */
const PENDING_CAPTURE_RECHECK_MS = 5 * 60_000
const PENDING_CONTESTS = ['open', 'deciding', 'pending_creator', 'failed']

export async function latestPayout(roomId: string): Promise<PayoutRow | null> {
  const rows = await db().query<PayoutRow>(`SELECT * FROM payouts WHERE room_id = $1 ORDER BY attempt DESC LIMIT 1`, [roomId])
  return rows[0] ?? null
}

export async function getPayoutView(roomId: string): Promise<PayoutView | null> {
  const room = await requireRoom(roomId)
  return payoutView(room, await latestPayout(roomId))
}

async function emitPayout(roomId: string): Promise<PayoutView | null> {
  const view = await getPayoutView(roomId)
  if (view) emit(roomId, { type: 'payout.updated', payout: view }, CREATOR)
  return view
}

async function setPayoutState(roomId: string, state: PayoutState): Promise<void> {
  await db().query(`UPDATE rooms SET payout_state = $2 WHERE id = $1`, [roomId, state])
}

/** The ledger-built recap PayPal shows the creator with the payout. */
function recap(room: RoomRow, p: { answered: number; unanswered: number; gross: number; fees: number; refunds: number; platformFee: number; amount: number }): string {
  return (
    `AnswerTab payout for "${room.title}": ${p.answered} answered, ${p.unanswered} not answered. ` +
    `Captured ${formatCents(p.gross)}, PayPal fees ${formatCents(p.fees)}, refunds ${formatCents(p.refunds)}, ` +
    `platform fee ${formatCents(p.platformFee)}. Payout ${formatCents(p.amount)}.`
  )
}

/** Capture and refund amounts as PayPal reports them. `pending` counts captures PayPal has not completed yet. */
async function payoutInputs(room: RoomRow) {
  const tabs = await db().query<TabRow>(`SELECT * FROM tabs WHERE room_id = $1 AND capture_id IS NOT NULL`, [room.id])
  const gross: number[] = []
  const nets: number[] = []
  let fees = 0
  let pending = 0
  for (const t of tabs) {
    let status = t.capture_status
    let net = t.net_cents
    let g = t.captured_cents
    let fee = t.fee_cents
    if (!COMPLETED_CAPTURE.includes(status ?? '') || net === null) {
      const c = await getCapture(t.capture_id!, { roomId: room.id, fanId: t.fan_id, tabId: t.id })
      status = c.status
      net = c.netCents
      g = c.grossCents
      fee = c.feeCents
      await db().query(
        `UPDATE tabs SET capture_status = $2, net_cents = $3, fee_cents = $4, captured_cents = $5,
           state = CASE WHEN $2 = ANY($6::text[]) THEN 'captured' ELSE state END,
           auth_status = CASE WHEN $2 = ANY($6::text[]) THEN 'CAPTURED' ELSE auth_status END WHERE id = $1`,
        [t.id, status, net, fee, g, COMPLETED_CAPTURE],
      )
    }
    if (status === 'PENDING') pending++
    // Refunds are subtracted separately below, so a refunded capture still counts with its original net.
    if (!COMPLETED_CAPTURE.includes(status ?? '') || net === null) continue
    gross.push(g)
    nets.push(net)
    fees += fee ?? 0
  }
  const contests = await db().query<ContestRow>(`SELECT * FROM contests WHERE room_id = $1 AND refund_id IS NOT NULL`, [room.id])
  const refundNets: number[] = []
  for (const c of contests) {
    // PayPal keeps the original fee on refunds; read the refund's own net. If the read fails, the gross refund is
    // used, which can only make the payout smaller.
    const r = await getRefund(c.refund_id!, { roomId: room.id, tabId: c.tab_id, contestId: c.id }).catch(() => null)
    refundNets.push(r ? r.netCents : (c.refund_cents ?? 0))
  }
  const [counts] = await db().query<{ answered: number; unanswered: number }>(
    `SELECT count(*) FILTER (WHERE state = 'approved')::int AS answered, count(*) FILTER (WHERE state = 'unpaid')::int AS unanswered FROM questions WHERE room_id = $1`,
    [room.id],
  )
  return { gross, nets, refundNets, fees, pending, answered: counts?.answered ?? 0, unanswered: counts?.unanswered ?? 0 }
}

type PayoutInputs = Awaited<ReturnType<typeof payoutInputs>>

/** Only a definitive refusal ends an attempt; a lost response or a 5xx leaves it open for a resend with the same id. */
const attemptFailed = (p: PayoutRow) => p.batch_status === 'FAILED' || p.batch_status === 'DENIED'

/**
 * Close the contest window and send the payout. `force` is the labeled demo control (demo rooms only).
 * Returns { again } for the job when it has to wait (window still open, contests or captures still pending).
 */
export async function closeContestWindow(roomId: string, opts: { force: boolean }): Promise<{ payout: PayoutView | null; again?: Date }> {
  const room = await requireRoom(roomId)
  if (opts.force && room.kind !== 'demo') throw forbidden('demo_only', 'Closing the contest window early is a demo-room control.')
  if (room.status === 'voided') {
    if (opts.force) throw conflict('nothing_to_pay', 'Nothing was charged in this room, so there is no payout.')
    return { payout: null }
  }
  if (room.status !== 'settled') {
    if (opts.force) throw conflict('not_settled', 'Settle the room first.')
    return { payout: null }
  }
  const existing = await latestPayout(roomId)
  if (existing && !attemptFailed(existing)) {
    if (existing.payout_batch_id || existing.batch_status !== 'CREATING') return { payout: payoutView(room, existing) }
    // The last send's outcome is unknown: resend the SAME sender_batch_id. PayPal refuses a duplicate and the
    // original batch is recovered from it, so the creator is never paid twice.
    return { payout: await sendPayout(room, existing, await payoutInputs(room), { resend: true }) }
  }

  if (!opts.force && room.contest_window_ends_at && new Date(room.contest_window_ends_at).getTime() > now()) {
    return { payout: null, again: new Date(room.contest_window_ends_at) }
  }
  await recoverStaleContests(roomId)
  const pending = await db().query<{ n: number }>(`SELECT count(*)::int AS n FROM contests WHERE room_id = $1 AND state = ANY($2::text[])`, [roomId, PENDING_CONTESTS])
  if ((pending[0]?.n ?? 0) > 0) {
    if (opts.force) throw conflict('contests_pending', 'Decide the open contests first; the payout must account for their refunds.')
    return { payout: null, again: new Date(now() + CONTEST_RECHECK_MS) }
  }
  const inputs = await payoutInputs(room)
  if (inputs.pending > 0) {
    if (opts.force) throw conflict('captures_pending', 'A capture is still pending at PayPal; the payout is sent once it completes.')
    return { payout: null, again: new Date(now() + PENDING_CAPTURE_RECHECK_MS) }
  }
  if (opts.force) {
    await db().query(`UPDATE rooms SET contest_window_ends_at = LEAST(contest_window_ends_at, $2) WHERE id = $1`, [roomId, nowDate()])
    await emitRoomState(roomId)
  }
  return { payout: await sendPayout(room, existing, inputs) }
}

async function sendPayout(room: RoomRow, previous: PayoutRow | null, inputs: PayoutInputs, opts: { resend?: boolean } = {}): Promise<PayoutView | null> {
  let attempt: number
  let amountCents: number
  let platformFeeCents: number
  if (opts.resend && previous) {
    // Same attempt, same amount: this is the payout already decided, only its outcome was lost.
    attempt = previous.attempt
    amountCents = previous.amount_cents
    platformFeeCents = previous.platform_fee_cents
  } else {
    ;({ amountCents, platformFeeCents } = payoutAmount({
      captureGrossCents: inputs.gross,
      captureNetCents: inputs.nets,
      refundNetCents: inputs.refundNets,
      platformFeeBps: room.platform_fee_bps,
    }))
    attempt = (previous?.attempt ?? 0) + 1
  }
  if (amountCents <= 0) {
    await setPayoutState(room.id, 'none')
    await emitRoomState(room.id)
    return null
  }
  const receiver = opts.resend && previous ? previous.receiver : config().paypal.creatorPayeeEmail
  if (!receiver) throw new DomainError(503, 'payout_unconfigured', 'PAYPAL_CREATOR_PAYEE_EMAIL is not set, so there is no creator account to pay.')
  const senderBatchId = requestIds.payoutRequestId(room.id, attempt)
  // The row exists before the call, so createPayout can store payout_batch_id from the first response.
  await db().query(
    `INSERT INTO payouts (id, room_id, attempt, sender_batch_id, receiver, amount_cents, platform_fee_cents, batch_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'CREATING') ON CONFLICT (sender_batch_id) DO NOTHING`,
    [newId('po'), room.id, attempt, senderBatchId, receiver, amountCents, platformFeeCents],
  )
  await setPayoutState(room.id, 'pending')
  const note = recap(room, {
    answered: inputs.answered, unanswered: inputs.unanswered, gross: inputs.gross.reduce((a, b) => a + b, 0), fees: inputs.fees,
    refunds: inputs.refundNets.reduce((a, b) => a + b, 0), platformFee: platformFeeCents, amount: amountCents,
  })
  const send = () => createPayout({ roomId: room.id, attempt, receiverEmail: receiver, amountCents, note })
  try {
    let res
    try {
      res = await send()
    } catch (e) {
      // Lost response: the same sender_batch_id is answered from the original batch (recovered), never paid twice.
      if (isPayPalError(e) && e.httpStatus === 0) res = await send()
      else throw e
    }
    await db().query(`UPDATE payouts SET payout_batch_id = COALESCE(payout_batch_id, $2), batch_status = $3, updated_at = now() WHERE sender_batch_id = $1`, [
      senderBatchId, res.payoutBatchId, res.batchStatus || null,
    ])
    await applyBatchStatus(room.id, res.batchStatus, null)
    await scheduleJob(db(), { kind: 'poll_payout', roomId: room.id, runAt: new Date(now() + 5_000), payload: { polls: 0, since: now() } })
  } catch (e) {
    // Only a definitive 4xx refusal fails this attempt (the next one gets a new sender_batch_id). A lost response
    // or a 5xx may have created the batch: the row stays CREATING and the next try resends the same id.
    const definitive = isPayPalError(e) && e.httpStatus >= 400 && e.httpStatus < 500 && !isDuplicatePayoutBatch(e)
    if (definitive) {
      await db().query(`UPDATE payouts SET batch_status = 'FAILED', updated_at = now() WHERE sender_batch_id = $1 AND payout_batch_id IS NULL`, [senderBatchId])
      await setPayoutState(room.id, 'failed')
    }
    await emitPayout(room.id)
    await emitRoomState(room.id)
    throw e
  }
  await emitRoomState(room.id)
  return emitPayout(room.id)
}

function stateFor(batchStatus: string | null, itemStatus: string | null): { state: PayoutState; terminal: boolean } {
  const b = (batchStatus ?? '').toUpperCase()
  const i = (itemStatus ?? '').toUpperCase()
  if (i === 'UNCLAIMED') return { state: 'unclaimed', terminal: true }
  if (i === 'FAILED' || i === 'RETURNED' || i === 'BLOCKED' || i === 'REFUNDED' || i === 'REVERSED') return { state: 'failed', terminal: true }
  if (b === 'DENIED') return { state: 'denied', terminal: true }
  if (b === 'CANCELED' || b === 'FAILED') return { state: 'failed', terminal: true }
  if (b === 'SUCCESS' && (i === '' || i === 'SUCCESS')) return { state: 'success', terminal: true }
  return { state: 'pending', terminal: false }
}

async function applyBatchStatus(roomId: string, batchStatus: string | null, itemStatus: string | null): Promise<boolean> {
  const s = stateFor(batchStatus, itemStatus)
  await setPayoutState(roomId, s.state)
  return s.terminal
}

/** poll_payout job: read the batch until it is terminal, backing off after 15 minutes, for up to 24 h. */
export async function pollPayout(roomId: string, polls = 0, since?: number): Promise<JobResult> {
  const p = await latestPayout(roomId)
  if (!p?.payout_batch_id) return
  const started = since ?? now()
  const batch = await getPayoutBatch(p.payout_batch_id, { roomId })
  const item = batch.items[0]
  await db().query(`UPDATE payouts SET batch_status = $2, fee_cents = COALESCE($3, fee_cents), item_status = $4, updated_at = now() WHERE id = $1`, [
    p.id, batch.batchStatus || p.batch_status, batch.feeCents ?? item?.feeCents ?? null, item?.transactionStatus ?? p.item_status,
  ])
  const terminal = await applyBatchStatus(roomId, batch.batchStatus, item?.transactionStatus ?? null)
  await emitPayout(roomId)
  await emitRoomState(roomId)
  if (terminal || now() - started >= POLL_FOR_MS) return
  return { again: new Date(now() + (polls + 1 < FAST_POLLS ? POLL_EVERY_MS : SLOW_POLL_MS)), payload: { polls: polls + 1, since: started } }
}

/** Webhook reconciliation for PAYMENT.PAYOUTSBATCH.* and PAYMENT.PAYOUTS-ITEM.*. */
export async function payoutWebhook(p: { payoutBatchId: string; batchStatus?: string | null; itemStatus?: string | null }): Promise<boolean> {
  const rows = await db().query<PayoutRow>(
    `UPDATE payouts SET webhook_seen = true, batch_status = COALESCE($2, batch_status), item_status = COALESCE($3, item_status), updated_at = now()
     WHERE payout_batch_id = $1 RETURNING *`,
    [p.payoutBatchId, p.batchStatus ?? null, p.itemStatus ?? null],
  )
  const row = rows[0]
  if (!row) return false
  await applyBatchStatus(row.room_id, row.batch_status, row.item_status)
  await emitPayout(row.room_id)
  return true
}

