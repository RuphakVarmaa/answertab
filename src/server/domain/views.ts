// Loaders that build API views from the DB, and the emitters that push them to the right audiences.
import type { QuestionView, RoomView } from '../../shared/types.js'
import { db, type Queryable } from '../db/db.js'
import { ALL, CREATOR, OTHERS, emit, toFan } from './bus.js'
import { notFound } from './errors.js'
import {
  QUESTION_SELECT,
  TAB_SELECT,
  creatorTabView,
  questionView,
  redactHidden,
  roomView,
  tabView,
  type QuestionJoined,
  type RoomRow,
  type TabJoined,
} from './rows.js'

export async function loadRoom(roomId: string, q: Queryable = db()): Promise<RoomRow | null> {
  const rows = await q.query<RoomRow>(`SELECT * FROM rooms WHERE id = $1`, [roomId])
  return rows[0] ?? null
}

export async function requireRoom(roomId: string, q: Queryable = db()): Promise<RoomRow> {
  const room = await loadRoom(roomId, q)
  if (!room) throw notFound('room_not_found', 'No such room.')
  return room
}

export async function questionViews(roomId: string, opts: { includeHidden: boolean }): Promise<QuestionView[]> {
  const rows = await db().query<QuestionJoined>(
    `${QUESTION_SELECT} WHERE q.room_id = $1 ${opts.includeHidden ? '' : `AND q.state <> 'hidden'`} ORDER BY q.number`,
    [roomId],
  )
  return rows.map(questionView)
}

export async function questionViewById(questionId: string): Promise<QuestionView | null> {
  const rows = await db().query<QuestionJoined>(`${QUESTION_SELECT} WHERE q.id = $1`, [questionId])
  return rows[0] ? questionView(rows[0]) : null
}

export async function buildRoomView(roomId: string, opts: { includeHidden: boolean }): Promise<RoomView> {
  const room = await requireRoom(roomId)
  return roomView(room, await questionViews(roomId, opts))
}

export async function loadTabJoined(where: 'id' | 'fan', value: string, roomId?: string): Promise<TabJoined | null> {
  const rows =
    where === 'id'
      ? await db().query<TabJoined>(`${TAB_SELECT} WHERE t.id = $1`, [value])
      : await db().query<TabJoined>(`${TAB_SELECT} WHERE t.fan_id = $1 AND t.room_id = $2`, [value, roomId])
  return rows[0] ?? null
}

export async function roomTabs(roomId: string): Promise<TabJoined[]> {
  return db().query<TabJoined>(`${TAB_SELECT} WHERE t.room_id = $1 ORDER BY t.created_at, t.id`, [roomId])
}

/** tab.updated: the creator gets name + bot flag; the fan gets only their own tab. */
export async function emitTab(tabId: string): Promise<void> {
  const t = await loadTabJoined('id', tabId)
  if (!t) return
  emit(t.room_id, { type: 'tab.updated', tab: creatorTabView(t) }, CREATOR)
  emit(t.room_id, { type: 'tab.updated', tab: tabView(t) }, toFan(t.fan_id))
}

export async function emitTabs(tabIds: Iterable<string>): Promise<void> {
  for (const id of new Set(tabIds)) await emitTab(id)
}

export async function emitQuestion(questionId: string, type: 'question.created' | 'question.updated' = 'question.updated'): Promise<QuestionView | null> {
  const v = await questionViewById(questionId)
  if (!v) return null
  const rows = await db().query<{ room_id: string }>(`SELECT room_id FROM questions WHERE id = $1`, [questionId])
  const roomId = rows[0]!.room_id
  if (v.state === 'hidden') {
    emit(roomId, { type, question: v }, CREATOR)
    emit(roomId, { type, question: redactHidden(v) }, OTHERS)
  } else {
    emit(roomId, { type, question: v }, ALL)
  }
  return v
}

export async function emitRoomState(roomId: string): Promise<void> {
  emit(roomId, { type: 'room.state', room: await buildRoomView(roomId, { includeHidden: false }) }, ALL)
}
