// Receipts: one unguessable URL per tab. Lines per backing with the quote, timestamp, source label and contest
// state; "Verify with PayPal" re-reads the authorization and capture live.
import type { ReceiptLine, ReceiptView } from '../../shared/types.js'
import { config } from '../config.js'
import { db } from '../db/db.js'
import { getAuthorization, getCapture } from '../paypal/index.js'
import { looksLikeToken } from './auth.js'
import { iso, now } from './clock.js'
import { hasOpenDispute } from './disputes.js'
import { notFound, tooMany } from './errors.js'
import { TAB_SELECT, contestView, tabView, type BackingRow, type ContestRow, type QuestionRow, type RoomRow, type TabJoined } from './rows.js'
import { recordCapture } from './settle.js'

export const VERIFY_EVERY_MS = 10_000

/** Where a line's money stands: reserved on the hold until the tab settles, then charged, released or refunded. */
export type ReceiptLineStatus = 'reserved' | 'charged' | 'released' | 'refunded'

/** chargeCents is null until the tab is settled (captured, voided or failed): nothing is decided before that. */
export type ReceiptLinePlus = Omit<ReceiptLine, 'chargeCents'> & { chargeCents: number | null; status: ReceiptLineStatus }

const SETTLED_TAB = ['captured', 'voided', 'failed']

export type ReceiptViewPlus = Omit<ReceiptView, 'lines'> & {
  lines: ReceiptLinePlus[]
  roomId: string
  roomStatus: RoomRow['status']
  captureStatus: string | null
  disputeOpen: boolean
  contestWindowOpen: boolean
}

export async function tabByReceipt(token: unknown): Promise<{ tab: TabJoined; room: RoomRow }> {
  if (!looksLikeToken(token)) throw notFound('receipt_not_found', 'No such receipt.')
  const [tab] = await db().query<TabJoined>(`${TAB_SELECT} WHERE t.receipt_token = $1`, [token])
  if (!tab) throw notFound('receipt_not_found', 'No such receipt.')
  const [room] = await db().query<RoomRow>(`SELECT * FROM rooms WHERE id = $1`, [tab.room_id])
  return { tab, room: room! }
}

export function contestWindowOpen(room: RoomRow): boolean {
  return room.status === 'settled' && room.contest_window_ends_at !== null && new Date(room.contest_window_ends_at).getTime() > now()
}

export async function getReceipt(token: unknown): Promise<ReceiptViewPlus> {
  const { tab, room } = await tabByReceipt(token)
  const rows = await db().query<BackingRow & Pick<QuestionRow, 'number' | 'rating' | 'quote' | 'quote_at_ms' | 'quote_source' | 'creator_confirmed' | 'quote_truncated'> & { question_text: string; q_state: string }>(
    `SELECT b.*, q.number, q.text AS question_text, q.state AS q_state, q.rating, q.quote, q.quote_at_ms, q.quote_source, q.creator_confirmed, q.quote_truncated
     FROM backings b JOIN questions q ON q.id = b.question_id WHERE b.tab_id = $1 ORDER BY q.number`,
    [tab.id],
  )
  const contests = await db().query<ContestRow>(`SELECT * FROM contests WHERE tab_id = $1`, [tab.id])
  const byBacking = new Map(contests.map((c) => [c.backing_id, c]))
  const settled = SETTLED_TAB.includes(tab.state)
  const lines: ReceiptLinePlus[] = rows.map((b) => {
    const c = byBacking.get(b.id)
    const moved = b.state === 'charged' || b.state === 'refunded'
    const status: ReceiptLineStatus = settled ? (moved ? b.state : 'released') : b.state === 'released' ? 'released' : 'reserved'
    return {
      backingId: b.id,
      questionNumber: b.number,
      questionText: b.question_text,
      kind: b.kind,
      amountCents: b.amount_cents,
      chargeCents: settled ? (moved ? (b.charge_cents ?? 0) : 0) : null,
      status,
      rating: b.rating,
      // Only approved answers carry a quote (a deflection's words are not an answer).
      quote: b.q_state === 'approved' ? b.quote : null,
      quoteAtMs: b.q_state === 'approved' ? b.quote_at_ms : null,
      quoteSource: b.q_state === 'approved' ? b.quote_source : null,
      creatorConfirmed: b.q_state === 'approved' && b.creator_confirmed,
      quoteTruncated: b.q_state === 'approved' && b.quote !== null && b.quote_truncated === true,
      contest: c ? contestView(c) : null,
    }
  })
  const [v] = await db().query<{ at: Date | string | null }>(
    `SELECT max(created_at) AS at FROM paypal_calls WHERE tab_id = $1 AND op = ANY($2::text[]) AND http_status = 200`,
    [tab.id, ['payments.authorization.get', 'payments.capture.get']],
  )
  return {
    roomId: room.id,
    roomTitle: room.title,
    roomStatus: room.status,
    fanName: tab.display_name,
    tab: receiptTab(tab),
    lines,
    contestDeadline: iso(room.contest_window_ends_at),
    verifiedAt: iso(v?.at ?? null),
    captureStatus: tab.capture_status,
    disputeOpen: await hasOpenDispute(tab.id),
    contestWindowOpen: contestWindowOpen(room),
  }
}

export interface VerifyResult {
  checkedAt: string
  authorization: { id: string; status: string; amountCents: number } | null
  capture: { id: string; status: string; grossCents: number; feeCents: number | null; netCents: number | null } | null
  matches: boolean
  mismatches: string[]
  receipt: ReceiptViewPlus
}

const lastVerify = new Map<string, number>()

/** Live re-read from PayPal (at most once per 10 s per receipt). A capture that completed meanwhile is reconciled. */
export async function verifyReceipt(token: unknown): Promise<VerifyResult> {
  const { tab } = await tabByReceipt(token)
  const last = lastVerify.get(tab.id)
  if (last !== undefined && now() - last < VERIFY_EVERY_MS) throw tooMany('verify_rate_limited', 'Verified a moment ago. Try again in a few seconds.')
  lastVerify.set(tab.id, now())
  const ctx = { roomId: tab.room_id, fanId: tab.fan_id, tabId: tab.id }
  const mismatches: string[] = []
  let authorization: VerifyResult['authorization'] = null
  let capture: VerifyResult['capture'] = null
  if (tab.authorization_id) {
    const a = await getAuthorization(tab.authorization_id, ctx)
    authorization = { id: a.authorizationId, status: a.status, amountCents: a.amountCents }
    if (a.amountCents !== tab.ceiling_cents) mismatches.push(`authorized ${a.amountCents} vs hold ${tab.ceiling_cents}`)
    if (tab.state === 'voided' && a.status !== 'VOIDED') mismatches.push(`authorization is ${a.status}, expected VOIDED`)
    if (tab.state === 'held' && a.status !== 'CREATED') mismatches.push(`authorization is ${a.status}, expected CREATED`)
  }
  if (tab.capture_id) {
    const c = await getCapture(tab.capture_id, ctx)
    capture = { id: c.captureId, status: c.status, grossCents: c.grossCents, feeCents: c.feeCents, netCents: c.netCents }
    if (c.grossCents !== tab.captured_cents) mismatches.push(`captured ${c.grossCents} vs receipt ${tab.captured_cents}`)
    if (tab.state === 'settling' && c.status !== tab.capture_status) {
      // e.g. PENDING -> COMPLETED since settlement: store PayPal's answer. A settled capture is never re-booked
      // (after a contest refund PayPal reports PARTIALLY_REFUNDED / REFUNDED; the refund is booked separately).
      await recordCapture(tab, c)
    }
  }
  return { checkedAt: new Date(now()).toISOString(), authorization, capture, matches: mismatches.length === 0, mismatches, receipt: await getReceipt(token) }
}

/** Without a registered webhook no event can arrive, so leave the badge field out and the receipt never polls for it. */
function receiptTab(tab: TabJoined): ReceiptView['tab'] {
  const view = tabView(tab)
  if (config().paypal.webhookId) return view
  const { captureWebhookAt: _unused, ...rest } = view
  return rest
}
