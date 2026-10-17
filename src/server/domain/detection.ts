// The live detection loop: one DetectorScheduler per live room. Verdicts pass the deterministic guard before
// any card changes state; big locks wait for the Opus verifier. AI trouble switches the room to manual confirm.
import type { AiMode, EvidenceSpan, QuestionState, Segment, Verdict } from '../../shared/types.js'
import {
  DetectorScheduler,
  aiEnabled,
  guardVerdict,
  setAiTroubleListener,
  verifyLock,
  type DetectorRun,
  type GuardResult,
  type OpenQ,
} from '../ai/index.js'
import { db } from '../db/db.js'
import { ALL, CREATOR, emit } from './bus.js'
import type { QuestionRow, RoomRow } from './rows.js'
import { emitQuestion, emitRoomState, loadRoom } from './views.js'

/** Cards the detector still looks at. Locked and verifying cards are out; review cards can still be upgraded. */
export const CANDIDATE_STATES: QuestionState[] = ['open', 'deflected', 'review']

const schedulers = new Map<string, DetectorScheduler>()
const modes = new Map<string, AiMode>()
const verifies = new Map<string, Set<Promise<void>>>()
const troubles = new Map<string, number[]>()
/** questionId -> answerStartMs of a lock the creator undid; evidence at or before it is not reused. */
const undoFloors = new Map<string, number>()

const TROUBLE_WINDOW_MS = 120_000
const TROUBLE_LIMIT = 3

function log(msg: string): void {
  if (process.env.VITEST !== 'true') console.warn(`[detection] ${msg}`)
}

async function backingsFor(roomId: string): Promise<Map<string, { amountCents: number; backedAtMs: number }[]>> {
  const rows = await db().query<{ question_id: string; amount_cents: number; backed_at_ms: number }>(
    `SELECT question_id, amount_cents, backed_at_ms FROM backings WHERE room_id = $1 AND state = 'reserved'`,
    [roomId],
  )
  const out = new Map<string, { amountCents: number; backedAtMs: number }[]>()
  for (const r of rows) {
    const list = out.get(r.question_id) ?? []
    list.push({ amountCents: r.amount_cents, backedAtMs: r.backed_at_ms })
    out.set(r.question_id, list)
  }
  return out
}

export function toOpenQ(q: QuestionRow, backings: { amountCents: number; backedAtMs: number }[]): OpenQ {
  return {
    number: q.number,
    text: q.clean_text || q.text,
    askedAtMs: q.asked_at_ms,
    cues: Array.isArray(q.cues) ? q.cues : [],
    backers: backings.length,
    lockedCents: backings.reduce((a, b) => a + b.amountCents, 0),
    backings,
  }
}

export async function openSet(roomId: string): Promise<OpenQ[]> {
  const qs = await db().query<QuestionRow>(`SELECT * FROM questions WHERE room_id = $1 AND state = ANY($2::text[]) ORDER BY number`, [roomId, CANDIDATE_STATES])
  const bs = await backingsFor(roomId)
  return qs.map((q) => toOpenQ(q, bs.get(q.id) ?? []))
}

export async function openQFor(q: QuestionRow): Promise<OpenQ> {
  const bs = await backingsFor(q.room_id)
  return toOpenQ(q, bs.get(q.id) ?? [])
}

export async function refreshOpenSet(roomId: string): Promise<void> {
  const s = schedulers.get(roomId)
  if (s) s.setOpenQuestions(await openSet(roomId))
}

export function onSegment(roomId: string, seg: Segment): void {
  schedulers.get(roomId)?.onSegment(seg)
}

export function emitVerdict(roomId: string, questionNumber: number, action: 'lock' | 'review' | 'deflected' | 'verifying' | 'ignore', quote: string | null, reason: string): void {
  emit(roomId, { type: 'verdict', questionNumber, action, quote, reason }, CREATOR)
}

export async function startDetector(room: RoomRow): Promise<void> {
  if (room.ai_mode === 'ai' && !aiEnabled()) await setRoomMode(room.id, 'manual', 'No Anthropic key: manual confirm')
  const current = await loadRoom(room.id)
  modes.set(room.id, current?.ai_mode ?? room.ai_mode)
  if (schedulers.has(room.id)) return
  const s = new DetectorScheduler({
    roomId: room.id,
    onVerdicts: (run) => handleRun(room.id, run),
    enabled: () => modes.get(room.id) === 'ai',
    onError: (e) => log(`room ${room.id}: ${e instanceof Error ? e.message : String(e)}`),
  })
  schedulers.set(room.id, s)
  await refreshOpenSet(room.id)
}

export function stopDetector(roomId: string): void {
  schedulers.get(roomId)?.stop()
  schedulers.delete(roomId)
}

export function stopAllDetectors(): void {
  for (const id of [...schedulers.keys()]) stopDetector(id)
}

export function isDetecting(roomId: string): boolean {
  return schedulers.has(roomId)
}

/** Run the detector now on the current window (tests, demo director). */
export function triggerDetection(roomId: string): void {
  schedulers.get(roomId)?.trigger('manual')
}

/** Resolves once no detector call or verifier check is in flight for the room. */
export async function detectionIdle(roomId: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await schedulers.get(roomId)?.idle()
    const set = verifies.get(roomId)
    if (!set || set.size === 0) return
    await Promise.allSettled([...set])
  }
}

export function markUndone(questionId: string, answerStartMs: number | null): void {
  if (answerStartMs !== null) undoFloors.set(questionId, Math.max(answerStartMs, undoFloors.get(questionId) ?? -1))
}

export function clearUndone(questionId: string): void {
  undoFloors.delete(questionId)
}

export async function setRoomMode(roomId: string, mode: AiMode, reason: string): Promise<boolean> {
  const rows = await db().query<{ id: string }>(
    `UPDATE rooms SET ai_mode = $2, ai_mode_reason = $3 WHERE id = $1 AND ai_mode <> $2 RETURNING id`,
    [roomId, mode, reason],
  )
  modes.set(roomId, mode)
  if (rows.length === 0) return false
  emit(roomId, { type: 'budget.mode', mode, reason }, ALL)
  await emitRoomState(roomId)
  return true
}

/** The AI layer reports unusable calls here. Budget and missing-key flip the room at once; errors after a streak. */
export function initDetection(): void {
  setAiTroubleListener(({ roomId, purpose, reason }) => {
    if (!roomId) return
    let flip: string | null = null
    if (reason === 'budget') flip = 'LLM budget reached: manual confirm'
    else if (reason === 'no_client') flip = 'No Anthropic key: manual confirm'
    else if (purpose === 'detect' || purpose === 'verify') {
      const t = Date.now()
      const list = (troubles.get(roomId) ?? []).filter((x) => t - x < TROUBLE_WINDOW_MS)
      list.push(t)
      troubles.set(roomId, list)
      if (list.length >= TROUBLE_LIMIT) flip = `Repeated AI errors (${reason}): manual confirm`
    }
    if (flip) {
      troubles.delete(roomId)
      setRoomMode(roomId, 'manual', flip).catch((e) => log(`could not switch ${roomId} to manual: ${String(e)}`))
    }
  })
}

function sourceOf(g: GuardResult, window: Segment[]): string | null {
  if (!g.span) return null
  return window.find((s) => s.seq === g.span!.startSeg)?.source ?? null
}

/**
 * The stored quote stops before the last word of its end segment (the guard only snaps gaps of 1-2 words), so
 * the UI finishes it with an ellipsis. Stored once with the evidence instead of recomputed per view.
 */
export function quoteTruncated(span: EvidenceSpan | null | undefined, window: Segment[]): boolean {
  if (!span) return false
  const end = window.find((s) => s.seq === span.endSeg)
  if (!end) return false
  const words = end.words.length > 0 ? end.words : end.text.trim().split(/\s+/)
  return span.endWord < words.length - 1
}

/** SQL for a card's next state: a lock (or verifier check) that lands after End goes to review instead. */
const LIVE_OR_REVIEW = (param: string) =>
  `CASE WHEN ${param} IN ('locked', 'verifying') AND (SELECT status FROM rooms r WHERE r.id = questions.room_id) <> 'live' THEN 'review' ELSE ${param} END`

async function writeEvidence(
  q: QuestionRow,
  state: QuestionState,
  v: { verdict: string; confidence: number | null },
  g: GuardResult,
  window: Segment[],
  allowed: QuestionState[],
  withAnswerStart = true,
): Promise<boolean> {
  const rows = await db().query<{ id: string }>(
    `UPDATE questions SET state = ${LIVE_OR_REVIEW('$2')}, verdict = $3, confidence = $4, span = $5::jsonb, quote = $6, quote_at_ms = $7,
       answer_start_ms = $8, quote_source = $9, creator_confirmed = false, verifier = NULL, quote_truncated = $11, updated_at = now()
     WHERE id = $1 AND state = ANY($10::text[]) RETURNING id`,
    [
      q.id, state, v.verdict, v.confidence, g.span ? JSON.stringify(g.span) : null, g.quote ?? null, g.quoteAtMs ?? null,
      withAnswerStart ? (g.answerStartMs ?? null) : null, sourceOf(g, window), allowed, g.quote ? quoteTruncated(g.span, window) : false,
    ],
  )
  return rows.length > 0
}

function track(roomId: string, p: Promise<void>): void {
  const set = verifies.get(roomId) ?? new Set<Promise<void>>()
  verifies.set(roomId, set)
  set.add(p)
  p.finally(() => set.delete(p)).catch(() => {})
}

async function runVerifier(roomId: string, q: QuestionRow, g: GuardResult, window: Segment[]): Promise<void> {
  const res = await verifyLock({
    roomId,
    question: { number: q.number, text: q.clean_text || q.text, askedAtMs: q.asked_at_ms },
    quote: g.quote ?? '',
    window,
    ...(g.span ? { span: g.span } : {}),
  })
  const rows = await db().query<{ id: string; state: QuestionState }>(
    `UPDATE questions SET state = ${LIVE_OR_REVIEW('$2')}, verifier = $3::jsonb, updated_at = now() WHERE id = $1 AND state = 'verifying' RETURNING id, state`,
    [q.id, res.agree ? 'locked' : 'review', JSON.stringify({ agree: res.agree, reason: res.reason })],
  )
  if (rows.length === 0) return // undone or hidden meanwhile
  const locked = rows[0]!.state === 'locked'
  const reason = res.agree && !locked ? `${res.reason} (the stream had ended, so the creator reviews it)` : res.reason
  emitVerdict(roomId, q.number, locked ? 'lock' : 'review', g.quote ?? null, reason)
  await emitQuestion(q.id)
  await refreshOpenSet(roomId)
}

/** Applies one verdict to its card. Returns true when the card changed. */
export async function applyVerdict(room: RoomRow, v: Verdict, window: Segment[]): Promise<boolean> {
  const rows = await db().query<QuestionRow>(`SELECT * FROM questions WHERE room_id = $1 AND number = $2`, [room.id, v.questionNumber])
  const q = rows[0]
  if (!q || !CANDIDATE_STATES.includes(q.state)) return false
  let g = guardVerdict(v, await openQFor(q), window)
  const floor = undoFloors.get(q.id)
  const start = g.answerStartMs ?? g.quoteAtMs
  if (g.action !== 'ignore' && g.action !== 'deflected' && floor !== undefined && start !== undefined && start <= floor) {
    g = { ...g, action: 'ignore', reason: 'the creator undid an answer from this part of the transcript' }
  }
  switch (g.action) {
    case 'ignore':
      emitVerdict(room.id, q.number, 'ignore', null, g.reason)
      return false
    case 'deflected': {
      if (q.state !== 'open') return false
      const ok = await writeEvidence(q, 'deflected', { verdict: 'deflected', confidence: g.confidence }, g, window, ['open', 'deflected'], false)
      if (!ok) return false
      emitVerdict(room.id, q.number, 'deflected', g.quote ?? null, g.reason)
      await emitQuestion(q.id)
      return true
    }
    case 'review': {
      if (q.state === 'review' && (q.confidence ?? 0) > g.confidence) return false
      const ok = await writeEvidence(q, 'review', { verdict: v.verdict, confidence: g.confidence }, g, window, CANDIDATE_STATES)
      if (!ok) return false
      emitVerdict(room.id, q.number, 'review', g.quote ?? null, g.reason)
      await emitQuestion(q.id)
      return true
    }
    case 'lock': {
      // After End nothing locks on its own any more: a late verdict sends the card to the creator's review.
      if ((await loadRoom(room.id))?.status !== 'live') {
        const ok = await writeEvidence(q, 'review', { verdict: v.verdict, confidence: g.confidence }, g, window, CANDIDATE_STATES)
        if (!ok) return false
        emitVerdict(room.id, q.number, 'review', g.quote ?? null, `${g.reason} (the stream had ended, so the creator reviews it)`)
        await emitQuestion(q.id)
        return true
      }
      const next: QuestionState = g.needsVerifier ? 'verifying' : 'locked'
      const ok = await writeEvidence(q, next, { verdict: v.verdict, confidence: g.confidence }, g, window, CANDIDATE_STATES)
      if (!ok) return false
      emitVerdict(room.id, q.number, g.needsVerifier ? 'verifying' : 'lock', g.quote ?? null, g.reason)
      await emitQuestion(q.id)
      if (g.needsVerifier) {
        track(
          room.id,
          runVerifier(room.id, q, g, window).catch((e) => log(`verifier failed for ${q.id}: ${String(e)}`)),
        )
      }
      return true
    }
  }
}

async function handleRun(roomId: string, run: DetectorRun): Promise<void> {
  const room = await loadRoom(roomId)
  if (!room || (room.status !== 'live' && room.status !== 'ended')) return
  let changed = false
  for (const v of run.verdicts) {
    try {
      changed = (await applyVerdict(room, v, run.window)) || changed
    } catch (e) {
      log(`verdict for Q${v.questionNumber} failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (run.verdicts.length > 0) troubles.delete(roomId)
  if (changed) await refreshOpenSet(roomId)
}

/** At boot: rebuild schedulers for live rooms; verifier checks lost in a restart go to review. */
export async function resumeLiveRooms(): Promise<number> {
  await db().query(`UPDATE questions SET state = 'review', verifier = '{"agree":false,"reason":"verifier interrupted by a restart"}'::jsonb WHERE state = 'verifying'`)
  const rooms = await db().query<RoomRow>(`SELECT * FROM rooms WHERE status = 'live'`)
  for (const r of rooms) await startDetector(r)
  return rooms.length
}
