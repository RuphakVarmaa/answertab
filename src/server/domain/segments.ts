// Transcript input (Mic / Type / Replay). The server stamps every final segment on the room clock at arrival.
import type { Segment, SegmentSource } from '../../shared/types.js'
import { db } from '../db/db.js'
import { newId } from '../ids.js'
import { ALL, emit } from './bus.js'
import { roomClockMs } from './clock.js'
import { onSegment } from './detection.js'
import { badRequest, conflict } from './errors.js'
import { segmentView, type RoomRow, type SegmentRow } from './rows.js'
import { requireRoom } from './views.js'

/** ARCHITECTURE: segments.words is text.split(/\s+/) after trimming. */
export function wordsOf(text: string): string[] {
  const t = text.trim()
  return t === '' ? [] : t.split(/\s+/)
}

export const MAX_SEGMENT_CHARS = 2000
export const MAX_LAG_MS = 3000
/** Speech runs at roughly 150-180 words a minute; a segment's start is estimated from its length. */
const MS_PER_WORD = 350

export function clampLag(lagMs: unknown): number {
  const n = typeof lagMs === 'number' && Number.isFinite(lagMs) ? lagMs : 0
  return Math.min(MAX_LAG_MS, Math.max(0, Math.round(n)))
}

/** End = arrival on the room clock minus recognition lag; start = end minus spoken length, never before the previous end. */
export function stampSegment(p: { clockMs: number; lagMs: unknown; words: number; prevEndMs: number | null }): { tStartMs: number; tEndMs: number } {
  const tEndMs = Math.max(0, p.clockMs - clampLag(p.lagMs))
  const est = Math.min(20_000, Math.max(600, p.words * MS_PER_WORD))
  const tStartMs = Math.min(tEndMs, Math.max(p.prevEndMs ?? 0, tEndMs - est))
  return { tStartMs, tEndMs }
}

export interface SegmentInput {
  text: unknown
  final: boolean
  source: SegmentSource
  lagMs?: unknown
  /** Replay only: scripted offsets on the room clock (the director passes them). */
  scripted?: { tStartMs: number; tEndMs: number }
}

export async function addSegment(roomId: string, p: SegmentInput): Promise<{ segment: Segment | null; interim: boolean }> {
  const room = await requireRoom(roomId)
  if (room.status !== 'live') throw conflict('not_live', room.status === 'draft' ? 'Start the stream first.' : 'The stream has ended.')
  const text = typeof p.text === 'string' ? p.text.replace(/\s+/g, ' ').trim() : ''
  if (!text) throw badRequest('empty_segment', 'Transcript text is empty.')
  if (text.length > MAX_SEGMENT_CHARS) throw badRequest('segment_too_long', `Send at most ${MAX_SEGMENT_CHARS} characters per segment.`)
  if (!p.final) {
    emit(roomId, { type: 'segment.interim', text: text.slice(-500) }, ALL)
    return { segment: null, interim: true }
  }
  const words = wordsOf(text)
  const row = await db().tx(async (q) => {
    const [r] = await q.query<RoomRow>(`SELECT status, clock_started_at FROM rooms WHERE id = $1 FOR UPDATE`, [roomId])
    if (!r || r.status !== 'live') throw conflict('not_live', 'The stream has ended.')
    const [prev] = await q.query<{ seq: number; t_end_ms: number }>(`SELECT seq, t_end_ms FROM segments WHERE room_id = $1 ORDER BY seq DESC LIMIT 1`, [roomId])
    const t = p.scripted ?? stampSegment({ clockMs: roomClockMs(r.clock_started_at), lagMs: p.lagMs, words: words.length, prevEndMs: prev?.t_end_ms ?? null })
    const [ins] = await q.query<SegmentRow>(
      `INSERT INTO segments (id, room_id, seq, text, words, t_start_ms, t_end_ms, source, final)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,true) RETURNING *`,
      [newId('seg'), roomId, (prev?.seq ?? 0) + 1, text, JSON.stringify(words), Math.round(t.tStartMs), Math.round(t.tEndMs), p.source],
    )
    return ins!
  })
  const segment = segmentView(row)
  emit(roomId, { type: 'segment.added', segment }, ALL)
  onSegment(roomId, segment)
  return { segment, interim: false }
}
