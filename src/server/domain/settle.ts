// End-of-stream settlement. Per fan: one capture with final_capture=true for approved, evidenced answers (PayPal
// releases the rest of the hold) or a void. Idempotent: rooms and tabs move through 'settling' under row locks,
// every write reuses its deterministic PayPal-Request-Id, and an unknown outcome is reconciled by a GET first.
import type { Rating, RoomView, TabView } from '../../shared/types.js'
import { chargeForBacking, settleAction, tabTotal } from '../../shared/money.js'
import { config } from '../config.js'
import { db } from '../db/db.js'
import { captureTab, getAuthorization, getCapture, getOrder, isPayPalError, voidTab, type ParsedCapture } from '../paypal/index.js'
import { ALL, emit } from './bus.js'
import { KEEP_AFTER_CONTEST_MS, WINDOWS, now, nowDate } from './clock.js'
import { conflict, notFound } from './errors.js'
import { cancelJob, scheduleJob, type JobResult } from './jobQueue.js'
import { creatorTabView, num, type QuestionRow, type RoomRow, type TabRow } from './rows.js'
import { buildRoomView, emitQuestion, emitRoomState, emitTab, loadRoom, roomTabs } from './views.js'

export type RatingsInput = Record<string, Rating>

export interface SettleResult {
  room: RoomView
  tabs: (TabView & { displayName: string; isBot: boolean })[]
  errors: { tabId: string; message: string }[]
}

/** How many tabs settle at once. Each tab's own steps stay sequential; the PayPal limiter bounds HTTP calls. */
const TAB_CONCURRENCY = 4
const NOTE_MAX = 255
/** A settle that ended with unknown outcomes is retried by a job: first after this, then with backoff. */
export const SETTLE_RETRY_MS = 60_000
const SETTLE_RETRY_MAX_MS = 15 * 60_000
const SETTLE_RETRY_TRIES = 48

/** Capture statuses that mean the money moved (a refund later does not undo the capture). */
export const COMPLETED_CAPTURE = ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED']

export function receiptUrl(token: string): string {
  return `${config().publicBaseUrl}/r/${token}`
}

/** note_to_payer: the first question, "and N more", and the receipt link, within PayPal's 255 characters. */
export function noteToPayer(questions: string[], receipt: string): string {
  const more = questions.length > 1 ? ` and ${questions.length - 1} more` : ''
  const tail = `${more}. Receipt: ${receipt}`
  const head = 'AnswerTab: "'
  const room = NOTE_MAX - head.length - 1 - tail.length
  const first = (questions[0] ?? 'your questions').replace(/\s+/g, ' ').trim()
  const q = first.length <= room ? first : `${first.slice(0, Math.max(0, room - 3))}...`
  return `${head}${q}"${tail}`.slice(0, NOTE_MAX)
}

async function mapPool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0
  const worker = async () => {
    while (i < items.length) await fn(items[i++]!)
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
}

const inflight = new Map<string, Promise<SettleResult>>()

/** Approve-all settlement. Concurrent or repeated calls share one run and never capture twice. */
export function settleRoom(roomId: string, ratings: RatingsInput, opts: { voidAll?: boolean } = {}): Promise<SettleResult> {
  const running = inflight.get(roomId)
  if (running) return running
  const p = doSettle(roomId, ratings, opts.voidAll === true).finally(() => inflight.delete(roomId))
  inflight.set(roomId, p)
  return p
}

async function summary(roomId: string, errors: SettleResult['errors'] = []): Promise<SettleResult> {
  return { room: await buildRoomView(roomId, { includeHidden: true }), tabs: (await roomTabs(roomId)).map(creatorTabView), errors }
}

/**
 * Locked cards default to full ("Approve all") only when they were already locked at End (or the creator pointed
 * the span themselves); a card that locked later is charged only when rated. Review cards are charged only when
 * rated; the rest are unpaid.
 */
function decide(q: QuestionRow, ratings: Map<number, Rating>, voidAll: boolean): { state: QuestionRow['state']; rating: Rating | null } | null {
  if (q.state === 'hidden' || q.state === 'approved' || q.state === 'unpaid') return null
  if (voidAll) return { state: 'unpaid', rating: null }
  const r = ratings.get(q.number)
  if (q.state === 'locked') {
    const rating = r ?? (q.locked_at_end || q.creator_confirmed ? 'full' : null)
    return rating === 'full' || rating === 'half' ? { state: 'approved', rating } : { state: 'unpaid', rating }
  }
  if (q.state === 'review') {
    return r === 'full' || r === 'half' ? { state: 'approved', rating: r } : { state: 'unpaid', rating: r ?? null }
  }
  return { state: 'unpaid', rating: null }
}

async function applyRatings(roomId: string, ratingsIn: RatingsInput, voidAll: boolean): Promise<{ status: RoomRow['status']; changed: string[] }> {
  const ratings = new Map<number, Rating>()
  for (const [k, v] of Object.entries(ratingsIn ?? {})) {
    const n = Number(k)
    if (Number.isSafeInteger(n) && (v === 'full' || v === 'half' || v === 'none')) ratings.set(n, v)
  }
  return db().tx(async (q) => {
    const [r] = await q.query<RoomRow>(`SELECT * FROM rooms WHERE id = $1 FOR UPDATE`, [roomId])
    if (!r) throw notFound('room_not_found', 'No such room.')
    if (r.status !== 'ended') {
      if (r.status === 'draft' || r.status === 'live') throw conflict('not_ended', 'End the stream before settling.')
      return { status: r.status, changed: [] }
    }
    const qs = await q.query<QuestionRow>(`SELECT * FROM questions WHERE room_id = $1 ORDER BY number FOR UPDATE`, [roomId])
    if (!voidAll && qs.some((x) => x.state === 'verifying')) {
      throw conflict('still_verifying', 'Claude is still double-checking a lock. Try again in a few seconds.')
    }
    const changed: string[] = []
    for (const qq of qs) {
      const d = decide(qq, ratings, voidAll)
      if (!d) continue
      await q.query(`UPDATE questions SET state = $2, rating = $3, updated_at = now() WHERE id = $1`, [qq.id, d.state, d.rating])
      changed.push(qq.id)
    }
    const bs = await q.query<{ id: string; amount_cents: number; backed_at_ms: number; q_state: string; rating: Rating | null; answer_start_ms: number | null }>(
      `SELECT b.id, b.amount_cents, b.backed_at_ms, q.state AS q_state, q.rating, q.answer_start_ms
       FROM backings b JOIN questions q ON q.id = b.question_id WHERE b.room_id = $1 AND b.state = 'reserved'`,
      [roomId],
    )
    const ids: string[] = []
    const charges: number[] = []
    for (const b of bs) {
      ids.push(b.id)
      charges.push(
        !voidAll && b.q_state === 'approved'
          ? chargeForBacking({ amountCents: b.amount_cents, rating: b.rating, backedAtMs: b.backed_at_ms, answerStartMs: b.answer_start_ms })
          : 0,
      )
    }
    if (ids.length > 0) {
      await q.query(
        `UPDATE backings b SET charge_cents = v.c FROM (SELECT unnest($1::text[]) AS id, unnest($2::int[]) AS c) v WHERE b.id = v.id`,
        [ids, charges],
      )
    }
    await q.query(`UPDATE rooms SET status = 'settling' WHERE id = $1`, [roomId])
    return { status: 'ended' as const, changed }
  })
}

async function doSettle(roomId: string, ratings: RatingsInput, voidAll: boolean): Promise<SettleResult> {
  const { status, changed } = await applyRatings(roomId, ratings, voidAll)
  if (status === 'settled' || status === 'voided') return summary(roomId)
  for (const id of changed) await emitQuestion(id)
  if (status === 'ended') await emitRoomState(roomId)

  const tabs = await db().query<{ id: string }>(`SELECT id FROM tabs WHERE room_id = $1 AND state IN ('held', 'settling') ORDER BY created_at, id`, [roomId])
  const errors: SettleResult['errors'] = []
  let done = 0
  emit(roomId, { type: 'settle.progress', done, total: tabs.length }, ALL)
  await mapPool(tabs, TAB_CONCURRENCY, async (t) => {
    try {
      const msg = await settleTab(t.id)
      if (msg) errors.push({ tabId: t.id, message: msg })
    } catch (e) {
      errors.push({ tabId: t.id, message: e instanceof Error ? e.message.slice(0, 300) : String(e) })
    }
    done++
    emit(roomId, { type: 'settle.progress', done, total: tabs.length }, ALL)
  })
  await finishRoom(roomId)
  // Unknown outcomes leave the room settling: a job resumes it (the creator can also POST /settle again).
  if ((await loadRoom(roomId))?.status === 'settling') {
    await scheduleJob(db(), { kind: 'settle_retry', roomId, runAt: new Date(now() + SETTLE_RETRY_MS), payload: { tries: 0 } })
  }
  return summary(roomId, errors)
}

/** settle_retry job: resume a settle left with unknown outcomes, with backoff, until the room is settled or voided. */
export async function retrySettle(roomId: string, tries: number): Promise<JobResult> {
  const r = await loadRoom(roomId)
  if (!r || r.status !== 'settling') return
  await settleRoom(roomId, {})
  if ((await loadRoom(roomId))?.status !== 'settling' || tries + 1 >= SETTLE_RETRY_TRIES) return
  return { again: new Date(now() + Math.min(SETTLE_RETRY_MS * 2 ** tries, SETTLE_RETRY_MAX_MS)), payload: { tries: tries + 1 } }
}

/** At boot: rooms a restart left in 'settling' are resumed by the sweeper right away. */
export async function resumeSettlingRooms(): Promise<number> {
  const rooms = await db().query<{ id: string }>(`SELECT id FROM rooms WHERE status = 'settling'`)
  for (const r of rooms) await scheduleJob(db(), { kind: 'settle_retry', roomId: r.id, runAt: nowDate(), payload: { tries: 0 } })
  return rooms.length
}

/** Settles one tab. Returns an error message when the tab could not be finished (it stays retryable or failed). */
export async function settleTab(tabId: string): Promise<string | null> {
  const plan = await db().tx(async (q) => {
    const [t] = await q.query<TabRow>(`SELECT * FROM tabs WHERE id = $1 FOR UPDATE`, [tabId])
    if (!t || (t.state !== 'held' && t.state !== 'settling')) return null
    const charges = await q.query<{ charge_cents: number | null }>(`SELECT charge_cents FROM backings WHERE tab_id = $1 AND state = 'reserved'`, [tabId])
    const total = tabTotal(charges.map((c) => num(c.charge_cents)), t.ceiling_cents)
    if (t.state === 'held') await q.query(`UPDATE tabs SET state = 'settling' WHERE id = $1`, [tabId])
    return { tab: t, action: settleAction(total), resumed: t.state === 'settling' }
  })
  if (!plan) return null
  await emitTab(tabId)
  const { tab, action } = plan
  const ctx = { roomId: tab.room_id, fanId: tab.fan_id, tabId: tab.id }
  if (!tab.authorization_id) return markFailed(tab, 'no authorization on this tab')

  if (tab.capture_id) {
    // A capture already exists (e.g. PENDING): read it back instead of capturing again.
    await recordCapture(tab, await getCapture(tab.capture_id, ctx))
    return null
  }
  if (plan.resumed) {
    // The last attempt's outcome is unknown (crash or lost response): look before writing again.
    const auth = await getAuthorization(tab.authorization_id, ctx)
    if (auth.status === 'VOIDED') return recordVoid(tab)
    if (auth.status === 'EXPIRED' || auth.status === 'DENIED') return markFailed(tab, `authorization is ${auth.status}`)
    if ((auth.status === 'CAPTURED' || auth.status === 'PARTIALLY_CAPTURED') && action.kind === 'void') {
      const cap = await findCapture(tab)
      if (cap) return recordCapture(tab, cap)
      return markFailed(tab, 'authorization captured but no capture found')
    }
    // CREATED, or CAPTURED by our own request: the same PayPal-Request-Id replays rather than charging again.
  }
  return action.kind === 'void' ? doVoid(tab) : doCapture(tab, action.amountCents)
}

async function findCapture(tab: TabRow): Promise<ParsedCapture | null> {
  if (!tab.order_id) return null
  const ctx = { roomId: tab.room_id, fanId: tab.fan_id, tabId: tab.id }
  const order = await getOrder(tab.order_id, ctx)
  const id = order.captureIds[0]
  return id ? getCapture(id, ctx) : null
}

const unknownOutcome = (e: { httpStatus: number }) => e.httpStatus === 0 || e.httpStatus >= 500

async function doCapture(tab: TabRow, amountCents: number): Promise<string | null> {
  const ctx = { roomId: tab.room_id, fanId: tab.fan_id, tabId: tab.id }
  const lines = await db().query<{ text: string }>(
    `SELECT q.text FROM backings b JOIN questions q ON q.id = b.question_id
     WHERE b.tab_id = $1 AND b.state = 'reserved' AND COALESCE(b.charge_cents, 0) > 0 ORDER BY q.number`,
    [tab.id],
  )
  const note = noteToPayer(lines.map((l) => l.text), tab.receipt_token ? receiptUrl(tab.receipt_token) : config().publicBaseUrl)
  const capture = () =>
    captureTab({
      roomId: tab.room_id, fanId: tab.fan_id, authorizationId: tab.authorization_id!, amountCents, noteToPayer: note,
      ...(tab.settle_attempt > 0 ? { attempt: tab.settle_attempt } : {}),
    })
  try {
    await recordCapture(tab, await capture())
    return null
  } catch (e) {
    if (!isPayPalError(e)) throw e
    if (e.issue === 'AUTHORIZATION_ALREADY_CAPTURED') {
      const cap = await findCapture(tab)
      if (cap) {
        await recordCapture(tab, cap)
        return null
      }
      return markFailed(tab, 'authorization already captured; capture not found')
    }
    if (unknownOutcome(e)) {
      const auth = await getAuthorization(tab.authorization_id!, ctx).catch(() => null)
      if (auth?.status === 'VOIDED') return recordVoid(tab)
      if (auth && ['CREATED', 'CAPTURED', 'PARTIALLY_CAPTURED'].includes(auth.status)) {
        try {
          await recordCapture(tab, await capture())
          return null
        } catch (e2) {
          if (isPayPalError(e2) && e2.issue === 'AUTHORIZATION_ALREADY_CAPTURED') {
            const cap = await findCapture(tab)
            if (cap) {
              await recordCapture(tab, cap)
              return null
            }
          }
        }
      }
      return `capture outcome unknown (${e.name}); the tab stays settling and is retried shortly`
    }
    return refusedCapture(tab, `${e.name}${e.issue ? `/${e.issue}` : ''}`)
  }
}

/**
 * PayPal definitively refused the capture: nothing was charged. If the hold is still open, void it (next -a{n}
 * suffix) so the fan's money is released now instead of when PayPal expires the authorization.
 */
async function refusedCapture(tab: TabRow, reason: string): Promise<string> {
  const ctx = { roomId: tab.room_id, fanId: tab.fan_id, tabId: tab.id }
  const auth = await getAuthorization(tab.authorization_id!, ctx).catch(() => null)
  let released = auth?.status === 'VOIDED'
  if (auth?.status === 'CREATED') {
    try {
      await voidTab({ roomId: tab.room_id, fanId: tab.fan_id, authorizationId: tab.authorization_id!, attempt: tab.settle_attempt + 1 })
      released = true
    } catch {
      released = false
    }
  }
  if (!released) return markFailed(tab, reason)
  await db().tx(async (q) => {
    await q.query(
      `UPDATE tabs SET state = 'failed', settle_attempt = settle_attempt + 1, capture_status = $2, auth_status = 'VOIDED', captured_cents = 0,
         released_cents = ceiling_cents, settled_at = COALESCE(settled_at, $3) WHERE id = $1`,
      [tab.id, reason.slice(0, 120), nowDate()],
    )
    await q.query(`UPDATE backings SET state = 'released', charge_cents = 0 WHERE tab_id = $1 AND state = 'reserved'`, [tab.id])
  })
  await emitTab(tab.id)
  return `${reason}; nothing was charged and the hold was released`
}

async function doVoid(tab: TabRow): Promise<string | null> {
  const ctx = { roomId: tab.room_id, fanId: tab.fan_id, tabId: tab.id }
  const voidIt = () => voidTab({ roomId: tab.room_id, fanId: tab.fan_id, authorizationId: tab.authorization_id!, ...(tab.settle_attempt > 0 ? { attempt: tab.settle_attempt } : {}) })
  try {
    await voidIt()
    return recordVoid(tab)
  } catch (e) {
    if (!isPayPalError(e)) throw e
    const auth = await getAuthorization(tab.authorization_id!, ctx).catch(() => null)
    if (auth?.status === 'VOIDED') return recordVoid(tab)
    if (auth?.status === 'CREATED' && unknownOutcome(e)) {
      try {
        await voidIt()
        return recordVoid(tab)
      } catch {
        return `void outcome unknown (${e.name}); the tab stays settling and is reconciled on the next settle`
      }
    }
    if (unknownOutcome(e)) return `void outcome unknown (${e.name}); the tab stays settling`
    return markFailed(tab, `${e.name}${e.issue ? `/${e.issue}` : ''}`)
  }
}

/**
 * Store PayPal's own numbers. A PENDING capture keeps the tab 'settling' (shown as pending, never paid). A capture
 * read back after a contest refund (PARTIALLY_REFUNDED / REFUNDED) is still a completed capture.
 */
export async function recordCapture(tab: TabRow, cap: ParsedCapture): Promise<null> {
  const completed = COMPLETED_CAPTURE.includes(cap.status)
  const pending = cap.status === 'PENDING'
  const failed = cap.status === 'DECLINED' || cap.status === 'FAILED'
  const gross = failed ? 0 : cap.grossCents
  await db().tx(async (q) => {
    await q.query(
      `UPDATE tabs SET capture_id = $2, capture_status = $3, captured_cents = $4, fee_cents = $5, net_cents = $6, released_cents = $7,
         auth_status = $8, state = $9, settled_at = COALESCE(settled_at, $10) WHERE id = $1`,
      [
        tab.id, cap.captureId, cap.status, gross, cap.feeCents, cap.netCents, failed ? 0 : Math.max(0, tab.ceiling_cents - gross),
        completed ? 'CAPTURED' : pending ? 'PENDING' : tab.auth_status, completed ? 'captured' : failed ? 'failed' : 'settling', nowDate(),
      ],
    )
    if (!failed) {
      await q.query(
        `UPDATE backings SET state = CASE WHEN COALESCE(charge_cents, 0) > 0 THEN 'charged' ELSE 'released' END, charge_cents = COALESCE(charge_cents, 0)
         WHERE tab_id = $1 AND state = 'reserved'`,
        [tab.id],
      )
    }
  })
  await emitTab(tab.id)
  return null
}

export async function recordVoid(tab: TabRow): Promise<null> {
  await db().tx(async (q) => {
    await q.query(
      `UPDATE tabs SET state = 'voided', auth_status = 'VOIDED', captured_cents = 0, released_cents = ceiling_cents, settled_at = COALESCE(settled_at, $2) WHERE id = $1`,
      [tab.id, nowDate()],
    )
    await q.query(`UPDATE backings SET state = 'released', charge_cents = 0 WHERE tab_id = $1 AND state = 'reserved'`, [tab.id])
  })
  await emitTab(tab.id)
  return null
}

/** A definitive refusal: nothing was charged. A retry would use the next -a{n} suffix after a GET. */
async function markFailed(tab: TabRow, reason: string): Promise<string> {
  await db().query(`UPDATE tabs SET state = 'failed', settle_attempt = settle_attempt + 1, capture_status = $2 WHERE id = $1`, [tab.id, reason.slice(0, 120)])
  await emitTab(tab.id)
  return reason
}

/** When no tab is left to settle: settled (contest window opens) if anything was charged, else voided. */
export async function finishRoom(roomId: string): Promise<void> {
  const changed = await db().tx(async (q) => {
    const [r] = await q.query<RoomRow>(`SELECT * FROM rooms WHERE id = $1 FOR UPDATE`, [roomId])
    if (!r || r.status !== 'settling') return false
    const [c] = await q.query<{ open: number; charged: number }>(
      `SELECT count(*) FILTER (WHERE state = 'held' OR (state = 'settling' AND capture_id IS NULL))::int AS open,
              count(*) FILTER (WHERE captured_cents > 0 AND state IN ('captured', 'settling'))::int AS charged
       FROM tabs WHERE room_id = $1`,
      [roomId],
    )
    if (num(c?.open) > 0) return false
    const charged = num(c?.charged) > 0
    const ends = charged ? new Date(now() + WINDOWS[r.kind].contestMs) : null
    // Receipts, contests and the payout need the tabs: expiry waits until a week after the contest window.
    const expires = ends ? new Date(Math.max(new Date(r.expires_at).getTime(), ends.getTime() + KEEP_AFTER_CONTEST_MS)) : new Date(r.expires_at)
    await q.query(`UPDATE rooms SET status = $2, contest_window_ends_at = $3, expires_at = $4 WHERE id = $1`, [roomId, charged ? 'settled' : 'voided', ends, expires])
    await cancelJob(q, 'auto_void', roomId)
    await cancelJob(q, 'settle_retry', roomId)
    if (ends) {
      await scheduleJob(q, { kind: 'close_contest_window', roomId, runAt: ends })
      await scheduleJob(q, { kind: 'expire_room', roomId, runAt: expires })
    }
    return true
  })
  if (changed) await emitRoomState(roomId)
}

/** Job at the approve deadline: nobody approved, so every hold is voided (or an interrupted settle resumes). */
export async function autoVoidRoom(roomId: string): Promise<void> {
  const [r] = await db().query<RoomRow>(`SELECT status FROM rooms WHERE id = $1`, [roomId])
  if (!r) return
  if (r.status === 'ended') await settleRoom(roomId, {}, { voidAll: true })
  else if (r.status === 'settling') await settleRoom(roomId, {})
}
