// Rows in the jobs table. One job per (kind, room); scheduling again moves it (unless it is running).
import type { Queryable } from '../db/db.js'
import { newId } from '../ids.js'

export type JobKind = 'auto_void' | 'auto_end' | 'settle_retry' | 'close_contest_window' | 'poll_payout' | 'expire_room'

export interface JobRow {
  id: string
  kind: JobKind
  room_id: string | null
  run_at: Date | string
  state: 'pending' | 'running' | 'done' | 'failed'
  attempts: number
  last_error: string | null
  payload: Record<string, unknown>
}

/** A handler returns { again } to run the same job later (e.g. poll a payout until it is terminal), optionally with a new payload. */
export type JobResult = void | { again: Date; payload?: Record<string, unknown> }

export async function scheduleJob(q: Queryable, p: { kind: JobKind; roomId: string; runAt: Date; payload?: Record<string, unknown> }): Promise<void> {
  await q.query(
    `INSERT INTO jobs (id, kind, room_id, run_at, payload) VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (kind, room_id) DO UPDATE
       SET run_at = EXCLUDED.run_at, payload = EXCLUDED.payload, state = 'pending', attempts = 0, last_error = NULL
       WHERE jobs.state <> 'running'`,
    [newId('job'), p.kind, p.roomId, p.runAt, JSON.stringify(p.payload ?? {})],
  )
}

export async function cancelJob(q: Queryable, kind: JobKind, roomId: string): Promise<void> {
  await q.query(`UPDATE jobs SET state = 'done', last_error = 'cancelled' WHERE kind = $1 AND room_id = $2 AND state = 'pending'`, [kind, roomId])
}
