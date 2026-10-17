// Job sweeper: claims due jobs with FOR UPDATE SKIP LOCKED, runs them outside the claim transaction, and
// reschedules or retries. Handlers are idempotent, so a job that ran twice after a crash does no harm.
import { db } from '../db/db.js'
import {
  autoEndRoom,
  autoVoidRoom,
  closeContestWindow,
  expireRoom,
  now,
  pollPayout,
  retrySettle,
  type JobKind,
  type JobResult,
  type JobRow,
} from '../domain/index.js'

const MAX_ATTEMPTS = 5

export const handlers: Record<JobKind, (job: JobRow) => Promise<JobResult>> = {
  auto_void: async (j) => {
    if (j.room_id) await autoVoidRoom(j.room_id)
  },
  auto_end: async (j) => {
    if (j.room_id) await autoEndRoom(j.room_id)
  },
  settle_retry: async (j) => (j.room_id ? retrySettle(j.room_id, Number(j.payload?.tries ?? 0)) : undefined),
  close_contest_window: async (j) => {
    if (!j.room_id) return
    const r = await closeContestWindow(j.room_id, { force: false })
    return r.again ? { again: r.again } : undefined
  },
  // Polls are counted in the payload, not in attempts, so a transient GET error never ends polling early.
  poll_payout: async (j) => (j.room_id ? pollPayout(j.room_id, Number(j.payload?.polls ?? 0), Number(j.payload?.since ?? 0) || undefined) : undefined),
  expire_room: async (j) => (j.room_id ? expireRoom(j.room_id) : undefined),
}

/** Claims and runs every job due now. Returns how many ran. */
export async function runDueJobs(limit = 10): Promise<number> {
  const claimed = await db().tx(async (q) => {
    const rows = await q.query<JobRow>(
      `SELECT * FROM jobs WHERE state = 'pending' AND run_at <= $1 ORDER BY run_at LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [new Date(now()), limit],
    )
    if (rows.length > 0) {
      await q.query(`UPDATE jobs SET state = 'running', attempts = attempts + 1 WHERE id = ANY($1::text[])`, [rows.map((r) => r.id)])
    }
    return rows.map((r) => ({ ...r, attempts: r.attempts + 1 }))
  })
  for (const job of claimed) {
    try {
      const handler = handlers[job.kind]
      const res = handler ? await handler(job) : undefined
      if (res && res.again) {
        // Rescheduled jobs restart their error count; progress (e.g. payout polls) lives in the payload.
        await db().query(
          `UPDATE jobs SET state = 'pending', run_at = $2, last_error = NULL, attempts = 0, payload = COALESCE($3::jsonb, payload) WHERE id = $1`,
          [job.id, res.again, res.payload ? JSON.stringify(res.payload) : null],
        )
      } else {
        await db().query(`UPDATE jobs SET state = 'done', last_error = NULL WHERE id = $1 AND state = 'running'`, [job.id])
      }
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300)
      const failed = job.attempts >= MAX_ATTEMPTS
      await db()
        .query(`UPDATE jobs SET state = $2, run_at = $3, last_error = $4 WHERE id = $1`, [
          job.id, failed ? 'failed' : 'pending', new Date(now() + 15_000 * 2 ** Math.min(job.attempts, 6)), msg,
        ])
        .catch(() => {})
      if (process.env.VITEST !== 'true') console.warn(`[jobs] ${job.kind} ${job.room_id ?? ''} failed (attempt ${job.attempts}): ${msg}`)
    }
  }
  return claimed.length
}

/** After a crash, jobs left 'running' go back to pending. */
export async function recoverStaleJobs(): Promise<void> {
  await db().query(`UPDATE jobs SET state = 'pending' WHERE state = 'running'`)
}

export function startSweeper(opts: { intervalMs?: number } = {}): { stop: () => Promise<void> } {
  const every = opts.intervalMs ?? 5_000
  let stopped = false
  let current: Promise<unknown> = Promise.resolve()
  const tick = () => {
    if (stopped) return
    current = runDueJobs()
      .catch((e) => console.warn(`[jobs] sweep failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, every)
      })
  }
  let timer: ReturnType<typeof setTimeout> = setTimeout(tick, every)
  return {
    async stop() {
      stopped = true
      clearTimeout(timer)
      await current
    },
  }
}
