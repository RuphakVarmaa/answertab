// Rooms: create, start (room clock), end (review list), public and console views, QR code.
import QRCode from 'qrcode'
import type { ConsoleView, ReviewItem, RoomKind, RoomView, WebhookEventView } from '../../shared/types.js'
import { aiEnabled } from '../ai/index.js'
import { config } from '../config.js'
import { db } from '../db/db.js'
import { newRoomId, newToken, sha256 } from '../ids.js'
import { listLedgerCalls } from '../paypal/index.js'
import { ipHash, judgeCodeMatches } from './auth.js'
import { ROOM_TTL_MS, WINDOWS, now, nowDate } from './clock.js'
import { startDetector, stopDetector } from './detection.js'
import { listDisputes, type DisputeView } from './disputes.js'
import { roomWebhooks } from './webhookList.js'
import { badRequest, conflict, notFound, tooMany } from './errors.js'
import { cancelJob, scheduleJob } from './jobQueue.js'
import {
  contestView,
  creatorTabView,
  isVerdictKind,
  payoutView,
  roomView,
  segmentView,
  type ContestRow,
  type PayoutRow,
  type QuestionJoined,
  type RoomRow,
  type SegmentRow,
  type TabRow,
} from './rows.js'
import { QUESTION_SELECT, num } from './rows.js'
import { COMPLETED_CAPTURE } from './settle.js'
import { buildRoomView, emitRoomState, loadRoom, questionViews, requireRoom, roomTabs } from './views.js'

export const DEFAULT_PRICES = { questionCents: 600, metooCents: 300, ceilingsCents: [1000, 2000, 4000], platformFeeBps: 500 } as const
/** Default public-pool rooms per IP per day; env ROOMS_PER_IP_PER_DAY overrides it (runbook: judging window). */
export const ROOMS_PER_IP_PER_DAY = 20

/** Read on every room creation, so an env change on the host applies after a restart without a code change. */
export function roomsPerIpPerDay(): number {
  const raw = process.env.ROOMS_PER_IP_PER_DAY
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw)
  return Number.isSafeInteger(n) && n > 0 ? n : ROOMS_PER_IP_PER_DAY
}
const DEFAULT_TITLE = 'Live office hours'
/** Speech-recognition languages a creator can pick (BCP-47, passed to the browser's Web Speech API). */
export const ROOM_LANGUAGES = ['en-US', 'en-GB', 'en-IN', 'en-AU', 'en-CA'] as const
const DEFAULT_LANGUAGE = 'en-US'

export function isRoomLanguage(v: unknown): v is (typeof ROOM_LANGUAGES)[number] {
  return typeof v === 'string' && (ROOM_LANGUAGES as readonly string[]).includes(v)
}

export function cleanText(s: unknown, max: number): string {
  if (typeof s !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

export interface CreateRoomInput {
  title?: string | undefined
  kind: RoomKind
  language?: string | undefined
  judgeCode?: string | undefined
  ip: string
}

export async function createRoom(p: CreateRoomInput): Promise<{ roomId: string; creatorToken: string; pool: 'judge' | 'public' }> {
  const pool = judgeCodeMatches(p.judgeCode) ? 'judge' : 'public'
  const ipH = ipHash(p.ip)
  if (pool === 'public') {
    const limit = roomsPerIpPerDay()
    const rows = await db().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM rooms WHERE created_ip_hash = $1 AND pool = 'public' AND created_at > $2`,
      [ipH, new Date(now() - 24 * 3600_000)],
    )
    if (num(rows[0]?.n) >= limit) {
      throw tooMany(
        'room_limit',
        `This network has already opened ${limit} public rooms today, the daily limit. Try again tomorrow, or enter a judge code to use the judge pool.`,
      )
    }
  }
  const title = cleanText(p.title, 80) || DEFAULT_TITLE
  const language = isRoomLanguage(p.language) ? p.language : DEFAULT_LANGUAGE
  const roomId = newRoomId()
  const creatorToken = newToken()
  const ai = aiEnabled()
  const created = nowDate()
  const expires = new Date(created.getTime() + ROOM_TTL_MS)
  await db().tx(async (q) => {
    await q.query(
      `INSERT INTO rooms (id, creator_token_hash, title, kind, pool, question_price_cents, metoo_price_cents, ceilings_cents,
         platform_fee_bps, language, ai_mode, ai_mode_reason, created_ip_hash, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15)`,
      [
        roomId, sha256(creatorToken), title, p.kind, pool, DEFAULT_PRICES.questionCents, DEFAULT_PRICES.metooCents,
        JSON.stringify(DEFAULT_PRICES.ceilingsCents), DEFAULT_PRICES.platformFeeBps, language,
        ai ? 'ai' : 'manual', ai ? null : 'No Anthropic key: manual confirm', ipH, created, expires,
      ],
    )
    await scheduleJob(q, { kind: 'expire_room', roomId, runAt: expires })
  })
  return { roomId, creatorToken, pool }
}

export function roomLinks(roomId: string, creatorToken?: string): { fanUrl: string; consoleUrl?: string; overlayUrl: string } {
  const base = config().publicBaseUrl
  return {
    fanUrl: `${base}/f/${roomId}`,
    overlayUrl: `${base}/o/${roomId}`,
    ...(creatorToken ? { consoleUrl: `${base}/c/${roomId}#k=${creatorToken}` } : {}),
  }
}

export async function startRoom(roomId: string): Promise<RoomView> {
  const room = await db().tx(async (q) => {
    const [r] = await q.query<RoomRow>(`SELECT * FROM rooms WHERE id = $1 FOR UPDATE`, [roomId])
    if (!r) throw notFound('room_not_found', 'No such room.')
    if (r.status === 'live') return r
    if (r.status !== 'draft') throw conflict('room_not_draft', `The room is ${r.status}; it cannot be started again.`)
    const started = nowDate()
    const [u] = await q.query<RoomRow>(`UPDATE rooms SET status = 'live', clock_started_at = $2 WHERE id = $1 RETURNING *`, [roomId, started])
    // An abandoned room must not keep fans' holds: it is ended for the creator after the longest stream we allow.
    await scheduleJob(q, { kind: 'auto_end', roomId, runAt: new Date(started.getTime() + WINDOWS[r.kind].maxLiveMs) })
    return u!
  })
  await startDetector(room)
  await emitRoomState(roomId)
  return buildRoomView(roomId, { includeHidden: true })
}

export async function endRoom(roomId: string): Promise<ReviewItemPlus[]> {
  const changed = await db().tx(async (q) => {
    const [r] = await q.query<RoomRow>(`SELECT * FROM rooms WHERE id = $1 FOR UPDATE`, [roomId])
    if (!r) throw notFound('room_not_found', 'No such room.')
    if (r.status !== 'draft' && r.status !== 'live') return false
    const ended = nowDate()
    const deadline = new Date(ended.getTime() + WINDOWS[r.kind].approveMs)
    await q.query(`UPDATE rooms SET status = 'ended', ended_at = $2, approve_deadline = $3 WHERE id = $1`, [roomId, ended, deadline])
    // Snapshot: only cards locked right now are charged by default at settle. Late verdicts go to review.
    await q.query(`UPDATE questions SET locked_at_end = (state = 'locked') WHERE room_id = $1`, [roomId])
    await scheduleJob(q, { kind: 'auto_void', roomId, runAt: deadline })
    await cancelJob(q, 'auto_end', roomId)
    return true
  })
  stopDetector(roomId)
  if (changed) await emitRoomState(roomId)
  return getReview(roomId)
}

/** auto_end job: a room still live after WINDOWS.maxLiveMs is ended; its approve deadline then voids the holds. */
export async function autoEndRoom(roomId: string): Promise<void> {
  const room = await loadRoom(roomId)
  if (room?.status === 'live') await endRoom(roomId)
}

/** Creator settings before or during the stream (speech-recognition language). */
export async function updateRoomSettings(roomId: string, p: { language?: unknown }): Promise<RoomView> {
  const room = await requireRoom(roomId)
  if (room.status !== 'draft' && room.status !== 'live') throw conflict('room_closed', 'Settings can only change before the stream ends.')
  if (p.language !== undefined) {
    if (!isRoomLanguage(p.language)) throw badRequest('bad_language', `Pick one of: ${ROOM_LANGUAGES.join(', ')}.`)
    await db().query(`UPDATE rooms SET language = $2 WHERE id = $1`, [roomId, p.language])
  }
  await emitRoomState(roomId)
  return buildRoomView(roomId, { includeHidden: true })
}

const REVIEW_ORDER: Record<string, number> = { locked: 0, verifying: 1, review: 2, approved: 3, deflected: 4, open: 5, unpaid: 6 }

/**
 * chargedByDefault: settle charges this card without an explicit rating (it was locked when End was clicked, or
 * the creator pointed its span). A card that locked after End needs a rating.
 */
export type ReviewItemPlus = ReviewItem & { chargedByDefault: boolean }

/** Every visible card with its evidence; lockedCents counts only backers who joined before the answer started. */
export async function getReview(roomId: string): Promise<ReviewItemPlus[]> {
  const room = await requireRoom(roomId)
  const ended = room.status !== 'draft' && room.status !== 'live'
  const qs = await db().query<QuestionJoined>(`${QUESTION_SELECT} WHERE q.room_id = $1 AND q.state <> 'hidden' ORDER BY q.number`, [roomId])
  const bs = await db().query<{ question_id: string; amount_cents: number; backed_at_ms: number; state: string }>(
    `SELECT question_id, amount_cents, backed_at_ms, state FROM backings WHERE room_id = $1 AND state <> 'released'`,
    [roomId],
  )
  const items: ReviewItemPlus[] = qs.map((q) => {
    const mine = bs.filter((b) => b.question_id === q.id)
    const eligible = q.answer_start_ms === null ? [] : mine.filter((b) => b.backed_at_ms <= q.answer_start_ms!)
    return {
      questionNumber: q.number,
      questionId: q.id,
      text: q.text,
      state: q.state,
      quote: q.quote,
      quoteTruncated: q.quote !== null && q.quote_truncated === true,
      confidence: q.confidence === null ? null : Number(q.confidence),
      verdict: isVerdictKind(q.verdict) ? q.verdict : null,
      backers: mine.length,
      lockedCents: eligible.reduce((a, b) => a + b.amount_cents, 0),
      chargedByDefault: q.state === 'locked' && (!ended || q.locked_at_end || q.creator_confirmed),
    }
  })
  return items.sort((a, b) => (REVIEW_ORDER[a.state] ?? 9) - (REVIEW_ORDER[b.state] ?? 9) || a.questionNumber - b.questionNumber)
}

export async function publicRoomView(roomId: string): Promise<RoomView> {
  return buildRoomView(roomId, { includeHidden: false })
}

/** Room money totals from PayPal's own numbers (completed captures and their refunds), integer cents. */
export interface RoomTotals {
  grossCents: number
  feeCents: number
  refundedCents: number
  netCents: number
}

export type ConsoleViewPlus = ConsoleView & {
  review: ReviewItemPlus[]
  disputes: DisputeView[]
  aiModeReason: string | null
  approveDeadline: string | null
  totals: RoomTotals
  webhooks: WebhookEventView[]
}

export function roomTotals(tabs: TabRow[]): RoomTotals {
  const t: RoomTotals = { grossCents: 0, feeCents: 0, refundedCents: 0, netCents: 0 }
  for (const x of tabs) {
    if (!x.capture_id || !COMPLETED_CAPTURE.includes(x.capture_status ?? '')) continue
    t.grossCents += x.captured_cents
    t.feeCents += x.fee_cents ?? 0
    t.refundedCents += x.refunded_cents
    t.netCents += x.net_cents ?? 0
  }
  // PayPal keeps the original fee on a refund, so the refunded amount comes out of the net in full.
  t.netCents -= t.refundedCents
  return t
}

export async function getConsoleView(roomId: string): Promise<ConsoleViewPlus> {
  const room = await requireRoom(roomId)
  const [questions, segs, tabs, ledger, contests, payouts, review, disputes, webhooks] = await Promise.all([
    questionViews(roomId, { includeHidden: true }),
    db().query<SegmentRow>(`SELECT * FROM (SELECT * FROM segments WHERE room_id = $1 ORDER BY seq DESC LIMIT 2000) s ORDER BY seq`, [roomId]),
    roomTabs(roomId),
    listLedgerCalls(roomId),
    db().query<ContestRow>(`SELECT * FROM contests WHERE room_id = $1 ORDER BY created_at`, [roomId]),
    db().query<PayoutRow>(`SELECT * FROM payouts WHERE room_id = $1 ORDER BY attempt DESC LIMIT 1`, [roomId]),
    getReview(roomId),
    listDisputes(roomId),
    roomWebhooks(roomId),
  ])
  return {
    room: roomView(room, questions),
    segments: segs.map(segmentView),
    tabs: tabs.map(creatorTabView),
    ledger,
    contests: contests.map(contestView),
    payout: payoutView(room, payouts[0] ?? null),
    llmSpentMicros: num(room.llm_spent_micros),
    webhooks,
    review,
    disputes,
    aiModeReason: room.ai_mode_reason,
    approveDeadline: room.approve_deadline ? new Date(room.approve_deadline).toISOString() : null,
    totals: roomTotals(tabs),
  }
}

export async function roomQrPng(roomId: string): Promise<Buffer> {
  await requireRoom(roomId)
  return QRCode.toBuffer(`${config().publicBaseUrl}/f/${roomId}`, { type: 'png', margin: 1, width: 512, errorCorrectionLevel: 'M' })
}

export async function cancelAutoVoid(roomId: string): Promise<void> {
  await cancelJob(db(), 'auto_void', roomId)
}
