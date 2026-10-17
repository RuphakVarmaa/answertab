// Questions and backings. Intake runs before any money is reserved; reservations happen in one transaction with
// the tab row locked, so a fan's active reservations never exceed the tab ceiling.
import type { EvidenceSpan, QuestionState, QuestionView, Segment } from '../../shared/types.js'
import { canReserve } from '../../shared/money.js'
import { guardCreatorSpan, intakeQuestion } from '../ai/index.js'
import { db, type Queryable } from '../db/db.js'
import { newId } from '../ids.js'
import { ALL, emit } from './bus.js'
import { roomClockMs } from './clock.js'
import { CANDIDATE_STATES, clearUndone, emitVerdict, markUndone, openQFor, quoteTruncated, refreshOpenSet } from './detection.js'
import { badRequest, conflict, notFound, unprocessable } from './errors.js'
import { num, segmentView, type FanRow, type QuestionRow, type RoomRow, type SegmentRow, type TabRow } from './rows.js'
import { emitQuestion, emitTab, emitTabs, questionViewById, requireRoom } from './views.js'

export const MAX_QUESTION_CHARS = 500
/** Me-too stays open on these; an answered (locked/approved) card closes to new backers. */
const BACKABLE: QuestionState[] = ['open', 'deflected', 'review']

const REJECT_MESSAGES: Record<string, string> = {
  abuse: 'This question was not posted: it breaks the room rules. You were not charged.',
  injection: 'This question was not posted: it reads like instructions to the system, not a question. You were not charged.',
  off_topic: 'This question was not posted: it is off topic for this stream. You were not charged.',
  empty: 'Type a question first.',
  too_long: `Keep questions under ${MAX_QUESTION_CHARS} characters.`,
}

async function reservedOn(q: Queryable, tabId: string): Promise<number> {
  const rows = await q.query<{ n: number }>(`SELECT COALESCE(sum(amount_cents), 0)::int AS n FROM backings WHERE tab_id = $1 AND state = 'reserved'`, [tabId])
  return num(rows[0]?.n)
}

function requireHeld(tab: TabRow | undefined): TabRow {
  if (!tab) throw conflict('no_tab', 'Open a tab first: asking and backing reserve money on your hold.')
  if (tab.state === 'declined') throw conflict('tab_declined', 'Your card was declined, so this tab cannot hold questions.')
  if (tab.state !== 'held') throw conflict('tab_not_held', 'Your hold is not active yet.')
  return tab
}

function fullTabError(ceiling: number, reserved: number, add: number) {
  return conflict('tab_full', 'Your tab is full: answered questions are charged from this hold, and it has no room left for this one.', {
    ceilingCents: ceiling,
    reservedCents: reserved,
    neededCents: add,
  })
}

const backableNow = (s: RoomRow['status']) => s === 'draft' || s === 'live'

export async function askQuestion(roomId: string, fan: FanRow, p: { text: unknown; checkSimilar?: boolean }): Promise<QuestionView> {
  const room = await requireRoom(roomId)
  if (!backableNow(room.status)) throw conflict('room_closed', 'Questions are closed: the stream has ended.')
  const text = typeof p.text === 'string' ? p.text.trim() : ''
  if (text.length > MAX_QUESTION_CHARS) throw badRequest('too_long', REJECT_MESSAGES.too_long!)
  const [tab0] = await db().query<TabRow>(`SELECT * FROM tabs WHERE room_id = $1 AND fan_id = $2`, [roomId, fan.id])
  const tab = requireHeld(tab0)
  // Cheap pre-check so a full tab never spends an intake call; the transaction below re-checks under a row lock.
  const reserved0 = await reservedOn(db(), tab.id)
  if (!canReserve(tab.ceiling_cents, reserved0, room.question_price_cents)) throw fullTabError(tab.ceiling_cents, reserved0, room.question_price_cents)

  const open = await db().query<{ number: number; clean_text: string }>(
    `SELECT number, clean_text FROM questions WHERE room_id = $1 AND state = ANY($2::text[]) ORDER BY number`,
    [roomId, BACKABLE],
  )
  const intake = await intakeQuestion({ roomId, text, openQuestions: open.map((o) => ({ number: o.number, text: o.clean_text })), roomTitle: room.title })
  if (!intake.allow) {
    const reason = intake.reason ?? 'rejected'
    throw unprocessable('question_rejected', REJECT_MESSAGES[reason] ?? 'This question was not posted. You were not charged.', { reason })
  }
  if (p.checkSimilar && intake.similarTo !== undefined) {
    const similar = open.find((o) => o.number === intake.similarTo)
    throw conflict('similar_question', `Similar to #${intake.similarTo}. Back it instead?`, { similarTo: intake.similarTo, similarText: similar?.clean_text ?? null })
  }

  const questionId = await db().tx(async (q) => {
    const [r] = await q.query<RoomRow>(`SELECT * FROM rooms WHERE id = $1 FOR UPDATE`, [roomId])
    if (!r || !backableNow(r.status)) throw conflict('room_closed', 'Questions are closed: the stream has ended.')
    const [t] = await q.query<TabRow>(`SELECT * FROM tabs WHERE id = $1 FOR UPDATE`, [tab.id])
    requireHeld(t)
    const reserved = await reservedOn(q, tab.id)
    if (!canReserve(t!.ceiling_cents, reserved, r.question_price_cents)) throw fullTabError(t!.ceiling_cents, reserved, r.question_price_cents)
    const [{ n }] = (await q.query<{ n: number }>(`SELECT COALESCE(max(number), 0)::int + 1 AS n FROM questions WHERE room_id = $1`, [roomId])) as [{ n: number }]
    const askedAt = roomClockMs(r.clock_started_at)
    const id = newId('q')
    await q.query(
      `INSERT INTO questions (id, room_id, number, asker_fan_id, text, clean_text, cues, similar_to, asked_at_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
      [id, roomId, num(n), fan.id, text, intake.cleanText || text, JSON.stringify(intake.cues ?? []), intake.similarTo ?? null, askedAt],
    )
    await q.query(
      `INSERT INTO backings (id, question_id, room_id, fan_id, tab_id, kind, amount_cents, backed_at_ms) VALUES ($1,$2,$3,$4,$5,'ask',$6,$7)`,
      [newId('bk'), id, roomId, fan.id, tab.id, r.question_price_cents, askedAt],
    )
    return id
  })
  const view = await emitQuestion(questionId, 'question.created')
  await emitTab(tab.id)
  await refreshOpenSet(roomId)
  return view!
}

async function questionAndRoom(questionId: string): Promise<{ q: QuestionRow; room: RoomRow }> {
  const [q] = await db().query<QuestionRow>(`SELECT * FROM questions WHERE id = $1`, [questionId])
  if (!q) throw notFound('question_not_found', 'No such question.')
  return { q, room: await requireRoom(q.room_id) }
}

/** The room a question belongs to (routes use it to check the caller's token). */
export async function roomOfQuestion(questionId: string): Promise<string> {
  return (await questionAndRoom(questionId)).q.room_id
}

export async function backQuestion(questionId: string, fan: FanRow): Promise<QuestionView> {
  const { q: q0, room } = await questionAndRoom(questionId)
  if (q0.room_id !== fan.room_id) throw notFound('question_not_found', 'No such question.')
  if (!backableNow(room.status)) throw conflict('room_closed', 'Backing is closed: the stream has ended.')
  const tabId = await db().tx(async (q) => {
    const [qq] = await q.query<QuestionRow>(`SELECT * FROM questions WHERE id = $1 FOR UPDATE`, [questionId])
    if (!qq || qq.state === 'hidden') throw notFound('question_not_found', 'No such question.')
    if (!BACKABLE.includes(qq.state)) throw conflict('backing_closed', 'This question was already answered, so it is closed to new backers.')
    const dup = await q.query(`SELECT 1 FROM backings WHERE question_id = $1 AND fan_id = $2`, [questionId, fan.id])
    if (dup.length > 0) throw conflict('already_backed', 'You are already on this question.')
    const [t] = await q.query<TabRow>(`SELECT * FROM tabs WHERE room_id = $1 AND fan_id = $2 FOR UPDATE`, [room.id, fan.id])
    const tab = requireHeld(t)
    const reserved = await reservedOn(q, tab.id)
    if (!canReserve(tab.ceiling_cents, reserved, room.metoo_price_cents)) throw fullTabError(tab.ceiling_cents, reserved, room.metoo_price_cents)
    const [r] = await q.query<RoomRow>(`SELECT status, clock_started_at FROM rooms WHERE id = $1`, [room.id])
    if (!r || !backableNow(r.status)) throw conflict('room_closed', 'Backing is closed: the stream has ended.')
    await q.query(
      `INSERT INTO backings (id, question_id, room_id, fan_id, tab_id, kind, amount_cents, backed_at_ms) VALUES ($1,$2,$3,$4,$5,'metoo',$6,$7)`,
      [newId('bk'), questionId, room.id, fan.id, tab.id, room.metoo_price_cents, roomClockMs(r!.clock_started_at)],
    )
    return tab.id
  })
  const view = await emitQuestion(questionId)
  emit(room.id, { type: 'backing.created', questionId, backers: view!.backers, backedCents: view!.backedCents }, ALL)
  await emitTab(tabId)
  await refreshOpenSet(room.id)
  return view!
}

const preSettle = (s: RoomRow['status']) => s === 'draft' || s === 'live' || s === 'ended'

export async function hideQuestion(questionId: string): Promise<QuestionView> {
  const { room } = await questionAndRoom(questionId)
  if (!preSettle(room.status)) throw conflict('room_settled', 'Settlement has started; cards can no longer change.')
  const tabIds = await db().tx(async (q) => {
    const [qq] = await q.query<QuestionRow>(`SELECT * FROM questions WHERE id = $1 FOR UPDATE`, [questionId])
    if (!qq) throw notFound('question_not_found', 'No such question.')
    if (qq.state === 'approved' || qq.state === 'unpaid') throw conflict('room_settled', 'This card is already settled.')
    await q.query(`UPDATE questions SET state = 'hidden', updated_at = now() WHERE id = $1`, [questionId])
    const released = await q.query<{ tab_id: string }>(
      `UPDATE backings SET state = 'released', charge_cents = 0 WHERE question_id = $1 AND state = 'reserved' RETURNING tab_id`,
      [questionId],
    )
    return released.map((r) => r.tab_id)
  })
  const view = await emitQuestion(questionId)
  await emitTabs(tabIds)
  await refreshOpenSet(room.id)
  return view!
}

const CLEAR_EVIDENCE = `verdict = NULL, confidence = NULL, span = NULL, quote = NULL, quote_at_ms = NULL, answer_start_ms = NULL,
  quote_source = NULL, creator_confirmed = false, verifier = NULL, rating = NULL, quote_truncated = false, updated_at = now()`

/** Undo a lock (or a review/verifying card): back to open, free. The same evidence is not reused afterwards. */
export async function undoQuestion(questionId: string): Promise<QuestionView> {
  const { q, room } = await questionAndRoom(questionId)
  if (room.status !== 'live' && room.status !== 'ended') throw conflict('room_settled', 'Cards can only be undone before settlement.')
  if (!['locked', 'verifying', 'review', 'deflected'].includes(q.state)) throw conflict('nothing_to_undo', 'This card has no answer to undo.')
  const rows = await db().query<{ id: string }>(
    `UPDATE questions SET state = 'open', ${CLEAR_EVIDENCE} WHERE id = $1 AND state = ANY($2::text[]) RETURNING id`,
    [questionId, ['locked', 'verifying', 'review', 'deflected']],
  )
  if (rows.length === 0) throw conflict('nothing_to_undo', 'This card changed meanwhile; reload.')
  markUndone(questionId, q.answer_start_ms ?? q.quote_at_ms)
  emitVerdict(room.id, q.number, 'ignore', null, 'undone by the creator')
  const view = await emitQuestion(questionId)
  await refreshOpenSet(room.id)
  return view!
}

function validSpan(span: unknown): EvidenceSpan {
  const s = span as Partial<EvidenceSpan> | null
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
  if (!s || !ok(s.startSeg) || !ok(s.startWord) || !ok(s.endSeg) || !ok(s.endWord)) throw badRequest('bad_span', 'A span needs startSeg, startWord, endSeg and endWord (non-negative integers).')
  if (s.endSeg < s.startSeg || s.endSeg - s.startSeg > 50) throw badRequest('bad_span', 'The span is reversed or too long.')
  return { startSeg: s.startSeg, startWord: s.startWord, endSeg: s.endSeg, endWord: s.endWord }
}

/** Creator-pointed evidence for a missed answer (also manual-confirm mode). The same guard runs. */
export async function pointSpan(questionId: string, spanIn: unknown): Promise<QuestionView> {
  const span = validSpan(spanIn)
  const { q, room } = await questionAndRoom(questionId)
  if (room.status !== 'live' && room.status !== 'ended') throw conflict('room_settled', 'Spans can only be pointed before settlement.')
  if (![...CANDIDATE_STATES, 'locked', 'verifying'].includes(q.state)) throw conflict('not_pointable', 'This card cannot take an answer span.')
  const segRows = await db().query<SegmentRow>(
    `SELECT * FROM segments WHERE room_id = $1 AND final AND seq BETWEEN $2 AND $3 ORDER BY seq`,
    [room.id, span.startSeg, span.endSeg],
  )
  const window: Segment[] = segRows.map(segmentView)
  const g = guardCreatorSpan(span, await openQFor(q), window)
  if (g.action !== 'lock') throw unprocessable('span_rejected', `That span cannot be used as the answer: ${g.reason}.`, { reason: g.reason })
  const source = window.find((s) => s.seq === g.span?.startSeg)?.source ?? null
  const rows = await db().query<{ id: string }>(
    `UPDATE questions SET state = 'locked', verdict = 'answered', confidence = NULL, span = $2::jsonb, quote = $3, quote_at_ms = $4,
       answer_start_ms = $5, quote_source = $6, creator_confirmed = true, verifier = NULL, quote_truncated = $8, updated_at = now()
     WHERE id = $1 AND state = ANY($7::text[]) RETURNING id`,
    [
      questionId, JSON.stringify(g.span ?? span), g.quote ?? null, g.quoteAtMs ?? null, g.answerStartMs ?? null, source,
      [...CANDIDATE_STATES, 'locked', 'verifying'], g.quote ? quoteTruncated(g.span ?? span, window) : false,
    ],
  )
  if (rows.length === 0) throw conflict('not_pointable', 'This card changed meanwhile; reload.')
  clearUndone(questionId)
  emitVerdict(room.id, q.number, 'lock', g.quote ?? null, 'creator-pointed span')
  const view = await emitQuestion(questionId)
  await refreshOpenSet(room.id)
  return view!
}

export async function getQuestion(questionId: string): Promise<QuestionView> {
  const v = await questionViewById(questionId)
  if (!v) throw notFound('question_not_found', 'No such question.')
  return v
}
