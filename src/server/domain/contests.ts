// Contests ("I wasn't answered"). The Opus contest desk reads the record and reports a finding; this module owns
// every amount and PayPal call: the share comes from money.refundShare, the refund uses request id refund-{contest},
// and the policy gate in the AI layer decides auto-refund (<= $5, not_answered/deferred) versus creator approval.
import type { ContestFinding, ContestView, Segment } from '../../shared/types.js'
import { formatCents, refundShare as shareOf } from '../../shared/money.js'
import { runContestDesk, type ContestDeskDeps, type ContestOutcome } from '../ai/index.js'
import { db } from '../db/db.js'
import { newId } from '../ids.js'
import { getOrder, getRefund, isPayPalError, refundShare } from '../paypal/index.js'
import { CREATOR, emit, toFan } from './bus.js'
import { now, nowDate } from './clock.js'
import { hasOpenDispute } from './disputes.js'
import { badRequest, conflict, notFound } from './errors.js'
import { cleanText } from './rooms.js'
import { contestView, segmentView, type BackingRow, type ContestRow, type QuestionRow, type RoomRow, type SegmentRow, type TabRow } from './rows.js'
import { contestWindowOpen, tabByReceipt } from './receipts.js'
import { receiptUrl } from './settle.js'
import { emitTab } from './views.js'

const running = new Set<Promise<void>>()
/** Contests whose desk is queued or running in this process -> when it was queued (wall clock). */
const desks = new Map<string, number>()
/** A desk run that has not finished after this is treated as lost (a desk run takes 1-3 minutes). */
export const DESK_STALE_MS = 10 * 60_000

function track(p: Promise<void>): void {
  running.add(p)
  p.finally(() => running.delete(p)).catch(() => {})
}

const roomQueues = new Map<string, Promise<unknown>>()

/** One contest desk at a time per room, so concurrent contests cannot race past the room's LLM cap. */
function inRoomQueue<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
  const prev = roomQueues.get(roomId) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  roomQueues.set(roomId, next)
  next.finally(() => { if (roomQueues.get(roomId) === next) roomQueues.delete(roomId) }).catch(() => {})
  return next
}

const FAILED_EXPLANATION = 'The contest desk was interrupted before it decided; the creator will review this contest.'

/**
 * Contests left 'open' or 'deciding' with no desk working on them (a restart lost the run, or it hung) go to
 * 'failed', so the creator can decide them and the payout is not blocked forever. Boot passes no room.
 */
export async function recoverStaleContests(roomId?: string): Promise<number> {
  const rows = await db().query<ContestRow>(
    `SELECT * FROM contests WHERE state IN ('open', 'deciding') ${roomId ? 'AND room_id = $1' : ''}`,
    roomId ? [roomId] : [],
  )
  let n = 0
  for (const c of rows) {
    const queued = desks.get(c.id)
    if (queued !== undefined && now() - queued < DESK_STALE_MS) continue
    const x = await loadCtx(c.id)
    const moved = await db().query(
      `UPDATE contests SET state = 'failed', explanation = $2, refund_cents = $3 WHERE id = $1 AND state IN ('open', 'deciding') RETURNING id`,
      [c.id, FAILED_EXPLANATION, currentShare(x)],
    )
    if (moved.length > 0) {
      n++
      await emitContest(c.id)
    }
  }
  return n
}

/** The desk may only act while the contest is still its to decide (not after the creator decided it). */
async function deskOwns(contestId: string): Promise<boolean> {
  const [c] = await db().query<{ state: string }>(`SELECT state FROM contests WHERE id = $1`, [contestId])
  return c?.state === 'open' || c?.state === 'deciding'
}

/** Tests and the synthetic run: wait until no contest desk is working. */
export async function contestsIdle(): Promise<void> {
  while (running.size > 0) await Promise.allSettled([...running])
}

interface Ctx {
  contest: ContestRow
  backing: BackingRow
  tab: TabRow
  question: QuestionRow
  room: RoomRow
}

async function loadCtx(contestId: string): Promise<Ctx> {
  const [contest] = await db().query<ContestRow>(`SELECT * FROM contests WHERE id = $1`, [contestId])
  if (!contest) throw notFound('contest_not_found', 'No such contest.')
  const [backing] = await db().query<BackingRow>(`SELECT * FROM backings WHERE id = $1`, [contest.backing_id])
  const [tab] = await db().query<TabRow>(`SELECT * FROM tabs WHERE id = $1`, [contest.tab_id])
  const [question] = await db().query<QuestionRow>(`SELECT * FROM questions WHERE id = $1`, [backing!.question_id])
  const [room] = await db().query<RoomRow>(`SELECT * FROM rooms WHERE id = $1`, [contest.room_id])
  return { contest, backing: backing!, tab: tab!, question: question!, room: room! }
}

export async function contestRoomId(contestId: string): Promise<string> {
  const [c] = await db().query<{ room_id: string }>(`SELECT room_id FROM contests WHERE id = $1`, [contestId])
  if (!c) throw notFound('contest_not_found', 'No such contest.')
  return c.room_id
}

export async function emitContest(contestId: string): Promise<ContestView | null> {
  const [c] = await db().query<ContestRow>(`SELECT * FROM contests WHERE id = $1`, [contestId])
  if (!c) return null
  const [t] = await db().query<{ fan_id: string }>(`SELECT fan_id FROM tabs WHERE id = $1`, [c.tab_id])
  const view = contestView(c)
  emit(c.room_id, { type: 'contest.updated', contest: view }, CREATOR)
  if (t) emit(c.room_id, { type: 'contest.updated', contest: view }, toFan(t.fan_id))
  return view
}

/** What is still refundable for this backing: min(its charge minus refunds, capture minus refunds). */
function currentShare(x: Ctx): number {
  return shareOf(Math.max(0, (x.backing.charge_cents ?? 0) - x.backing.refunded_cents), x.tab.captured_cents, x.tab.refunded_cents)
}

const refundLocks = new Map<string, Promise<unknown>>()

/** Serializes refunds per tab so two contests can never refund more than was captured. */
function withTabLock<T>(tabId: string, fn: () => Promise<T>): Promise<T> {
  const prev = refundLocks.get(tabId) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  refundLocks.set(tabId, next)
  next.finally(() => { if (refundLocks.get(tabId) === next) refundLocks.delete(tabId) }).catch(() => {})
  return next
}

export async function issueRefund(
  contestId: string,
  requestedCents: number,
  meta: { finding?: ContestFinding | null; evidence?: string | null; explanation?: string | null } = {},
): Promise<{ refundId: string; status: string; amountCents: number }> {
  const { tab: tab0 } = await loadCtx(contestId)
  return withTabLock(tab0.id, async () => {
    const x = await loadCtx(contestId)
    if (x.contest.refund_id) return { refundId: x.contest.refund_id, status: 'COMPLETED', amountCents: x.contest.refund_cents ?? 0 }
    if (await hasOpenDispute(x.tab.id)) throw conflict('dispute_open', 'A PayPal dispute is open on this payment; refunds wait until it is resolved.')
    if (!x.tab.capture_id) throw conflict('not_captured', 'Nothing was captured on this tab.')
    const amount = Math.min(Math.max(0, Math.floor(requestedCents)), currentShare(x))
    if (amount <= 0) throw conflict('nothing_to_refund', 'Nothing is left to refund on this line.')
    const note = `AnswerTab refund for question #${x.question.number}: ${formatCents(amount)}.${x.tab.receipt_token ? ` Receipt: ${receiptUrl(x.tab.receipt_token)}` : ''}`
    const call = () => refundShare({ contestId, captureId: x.tab.capture_id!, amountCents: amount, noteToPayer: note })
    let res
    try {
      res = await call()
    } catch (e) {
      // Outcome unknown: the same refund-{contest} request id replays the refund instead of issuing a second one.
      if (isPayPalError(e) && e.httpStatus === 0) res = await call()
      else throw e
    }
    const gross = res.grossCents || amount
    await db().tx(async (q) => {
      await q.query(
        `UPDATE contests SET refund_id = $2, refund_cents = $3, state = 'refunded', finding = COALESCE($4, finding),
           evidence = COALESCE($5, evidence), explanation = COALESCE($6, explanation), decided_at = $7 WHERE id = $1`,
        [contestId, res.refundId, gross, meta.finding ?? null, meta.evidence ?? null, meta.explanation ?? null, nowDate()],
      )
      await q.query(`UPDATE tabs SET refunded_cents = refunded_cents + $2 WHERE id = $1`, [x.tab.id, gross])
      await q.query(`UPDATE backings SET refunded_cents = refunded_cents + $2, state = 'refunded' WHERE id = $1`, [x.backing.id, gross])
    })
    // Badge only, after the booking commits so it can never roll back a refund PayPal already made: the refund's
    // webhook can land before this call returns, so pick up a stored verified event.
    try {
      await db().query(
        `UPDATE contests SET refund_webhook_at = (
           SELECT min(received_at) FROM webhook_events
           WHERE verified AND resource_id = $2 AND event_type = 'PAYMENT.CAPTURE.REFUNDED' AND payload->'resource'->>'status' = 'COMPLETED')
         WHERE id = $1 AND refund_webhook_at IS NULL`,
        [contestId, res.refundId],
      )
    } catch {
      // The badge stays empty; the refund itself is booked.
    }
    await emitTab(x.tab.id)
    await emitContest(contestId)
    return { refundId: res.refundId, status: res.status, amountCents: gross }
  })
}

function clock(ms: number | null): string | null {
  if (ms === null) return null
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function contestDeps(): ContestDeskDeps {
  return {
    async load(contestId) {
      const x = await loadCtx(contestId)
      return {
        roomId: x.room.id,
        questionNumber: x.question.number,
        reason: x.contest.reason,
        messages: Array.isArray(x.contest.messages) ? x.contest.messages : [],
        progress: Array.isArray(x.contest.progress) ? x.contest.progress : [],
      }
    },
    async getCardRecord(contestId) {
      const x = await loadCtx(contestId)
      const q = x.question
      return {
        question_number: q.number,
        question: q.text,
        asked_at: clock(q.asked_at_ms),
        card_state: q.state,
        detector_verdict: q.verdict,
        detector_confidence: q.confidence,
        quote: q.quote,
        quote_at: clock(q.quote_at_ms),
        quote_source: q.quote_source,
        creator_confirmed: q.creator_confirmed,
        creator_rating: q.rating,
        verifier: q.verifier ?? null,
        this_fan: {
          kind: x.backing.kind,
          backed_at: clock(x.backing.backed_at_ms),
          amount: formatCents(x.backing.amount_cents),
          charged: formatCents(x.backing.charge_cents ?? 0),
        },
      }
    },
    async getTranscriptWindow(contestId, p) {
      const x = await loadCtx(contestId)
      const center = p.around === 'answer' ? (x.question.answer_start_ms ?? x.question.quote_at_ms ?? x.question.asked_at_ms) : x.question.asked_at_ms
      const rows = await db().query<SegmentRow>(
        `SELECT * FROM segments WHERE room_id = $1 AND final AND t_end_ms >= $2 AND t_start_ms <= $3 ORDER BY seq LIMIT 80`,
        [x.room.id, center - p.secondsBefore * 1000, center + p.secondsAfter * 1000],
      )
      return rows.map(segmentView) as Segment[]
    },
    async getOrder(contestId) {
      const x = await loadCtx(contestId)
      if (!x.tab.order_id) return null
      const o = await getOrder(x.tab.order_id, { roomId: x.room.id, tabId: x.tab.id, contestId })
      return o.raw
    },
    async getRefund(contestId) {
      const x = await loadCtx(contestId)
      if (!x.contest.refund_id) return null
      return (await getRefund(x.contest.refund_id, { roomId: x.room.id, tabId: x.tab.id, contestId })).raw
    },
    async getShare(contestId) {
      return { shareCents: currentShare(await loadCtx(contestId)) }
    },
    async refund(contestId, p) {
      if (!(await deskOwns(contestId))) throw conflict('not_pending', 'The creator already decided this contest.')
      return issueRefund(contestId, p.amountCents, { finding: p.finding, evidence: p.evidence, explanation: p.explanation })
    },
    async requestCreatorApproval(contestId, p) {
      await db().query(
        `UPDATE contests SET state = 'pending_creator', finding = $2, evidence = $3, explanation = $4, refund_cents = $5 WHERE id = $1 AND state IN ('open', 'deciding')`,
        [contestId, p.finding, p.evidence, p.explanation, p.amountCents],
      )
      await emitContest(contestId)
    },
    async uphold(contestId, p) {
      await db().query(
        `UPDATE contests SET state = 'upheld', finding = 'answered', evidence = $2, explanation = $3, decided_at = $4 WHERE id = $1 AND state IN ('open', 'deciding')`,
        [contestId, p.evidence, p.explanation, nowDate()],
      )
      await emitContest(contestId)
    },
    async persist(contestId, p) {
      await db().query(`UPDATE contests SET messages = $2::jsonb, progress = $3::jsonb WHERE id = $1`, [contestId, JSON.stringify(p.messages), JSON.stringify(p.progress)])
      await emitContest(contestId)
    },
  }
}

async function finishDesk(contestId: string, out: ContestOutcome): Promise<void> {
  if (out.state === 'failed') {
    // The desk could not decide: the creator decides, with the computed share as the proposal.
    const x = await loadCtx(contestId)
    await db().query(`UPDATE contests SET state = 'failed', explanation = $2, refund_cents = $3 WHERE id = $1 AND state IN ('open', 'deciding')`, [
      contestId, out.explanation, currentShare(x),
    ])
  } else if (out.state === 'upheld' && out.refundCents === 0) {
    await db().query(`UPDATE contests SET state = 'upheld', finding = $2, evidence = $3, explanation = $4, decided_at = $5 WHERE id = $1 AND state IN ('open', 'deciding')`, [
      contestId, out.finding, out.evidence, out.explanation || 'Nothing is left to refund on this line.', nowDate(),
    ])
  } else if (out.explanation) {
    await db().query(`UPDATE contests SET explanation = $2 WHERE id = $1`, [contestId, out.explanation])
  }
  await emitContest(contestId)
}

async function runDesk(contestId: string): Promise<void> {
  if (!(await deskOwns(contestId))) return
  await db().query(`UPDATE contests SET state = 'deciding' WHERE id = $1 AND state = 'open'`, [contestId])
  await emitContest(contestId)
  let out: ContestOutcome
  try {
    out = await runContestDesk({ contestId }, contestDeps())
  } catch (e) {
    out = { state: 'failed', finding: null, evidence: null, explanation: 'The contest desk could not finish; the creator will review this contest.', refundId: null, refundCents: null, turns: 0, costMicros: 0 }
    if (process.env.VITEST !== 'true') console.warn(`[contests] desk failed for ${contestId}: ${e instanceof Error ? e.message : String(e)}`)
  }
  await finishDesk(contestId, out)
}

export async function createContest(token: unknown, p: { backingId: unknown; reason: unknown }): Promise<ContestView> {
  const { tab, room } = await tabByReceipt(token)
  if (!contestWindowOpen(room)) throw conflict('window_closed', 'The contest window for this stream is closed.')
  if (typeof p.backingId !== 'string') throw badRequest('bad_backing', 'Pick a line to contest.')
  const reason = cleanText(p.reason, 500)
  if (reason.length < 3) throw badRequest('bad_reason', 'Say briefly why you were not answered.')
  const [b] = await db().query<BackingRow>(`SELECT * FROM backings WHERE id = $1 AND tab_id = $2`, [p.backingId, tab.id])
  if (!b) throw notFound('backing_not_found', 'That line is not on this receipt.')
  const prior = await db().query(`SELECT 1 FROM contests WHERE backing_id = $1`, [b.id])
  if (prior.length > 0) throw conflict('already_contested', 'This line is already contested.')
  if (b.state !== 'charged' || (b.charge_cents ?? 0) <= 0) throw conflict('not_charged', 'You were not charged for this line, so there is nothing to contest.')
  if (await hasOpenDispute(tab.id)) throw conflict('dispute_open', 'A PayPal dispute is open on this payment; it is handled there.')
  const id = newId('ct')
  const rows = await db().query<ContestRow>(
    `INSERT INTO contests (id, room_id, tab_id, backing_id, reason) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (backing_id) DO NOTHING RETURNING *`,
    [id, room.id, tab.id, b.id, reason],
  )
  if (!rows[0]) throw conflict('already_contested', 'This line is already contested.')
  desks.set(id, now())
  const view = (await emitContest(id))!
  track(inRoomQueue(room.id, () => runDesk(id)).finally(() => desks.delete(id)))
  return view
}

export async function decideContest(contestId: string, approve: boolean): Promise<ContestView> {
  let x = await loadCtx(contestId)
  // A desk lost in a restart (or stuck) must not block the creator: stale open/deciding contests become 'failed'.
  if (x.contest.state === 'open' || x.contest.state === 'deciding') {
    await recoverStaleContests(x.room.id)
    x = await loadCtx(contestId)
  }
  if (x.contest.state !== 'pending_creator' && x.contest.state !== 'failed') throw conflict('not_pending', `This contest is ${x.contest.state}; there is nothing to decide.`)
  let refundId: string | null = null
  if (approve) {
    const proposed = x.contest.refund_cents ?? currentShare(x)
    const r = await issueRefund(contestId, proposed, { explanation: `The creator approved a refund of ${formatCents(Math.min(proposed, currentShare(x)))}.` })
    refundId = r.refundId
  } else {
    await db().query(`UPDATE contests SET state = 'upheld', explanation = $2, decided_at = $3 WHERE id = $1`, [
      contestId, 'The creator reviewed the answer and kept the charge. You can still contact PayPal.', nowDate(),
    ])
  }
  const view = (await emitContest(contestId))!
  // The desk appends the creator's decision to its history and writes the closing explanation.
  track(
    inRoomQueue(x.room.id, async () => {
      const out = await runContestDesk({ contestId, resume: { approved: approve, refundId } }, contestDeps()).catch(() => null)
      if (out && out.state !== 'failed' && out.explanation) {
        await db().query(`UPDATE contests SET explanation = $2 WHERE id = $1`, [contestId, out.explanation])
        await emitContest(contestId)
      }
    }),
  )
  return view
}

export async function getContest(contestId: string): Promise<ContestView> {
  const [c] = await db().query<ContestRow>(`SELECT * FROM contests WHERE id = $1`, [contestId])
  if (!c) throw notFound('contest_not_found', 'No such contest.')
  return contestView(c)
}
