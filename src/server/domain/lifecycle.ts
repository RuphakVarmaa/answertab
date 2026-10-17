// Room expiry (7 days, or a week after the contest window): transcripts and fans are deleted (fans cascade to
// tabs, backings, questions, contests). The room row, payouts and the redacted PayPal ledger stay as the audit trail.
// Money comes first: a room that still holds money is ended and voided before anything is deleted, and a room
// whose contest window or payout is still open waits.
import { db } from '../db/db.js'
import { KEEP_AFTER_CONTEST_MS, now } from './clock.js'
import { stopDetector } from './detection.js'
import type { JobResult } from './jobQueue.js'
import { endRoom } from './rooms.js'
import { settleRoom } from './settle.js'
import { loadRoom } from './views.js'

const RECHECK_MS = 60 * 60_000
const PENDING_CONTESTS = ['open', 'deciding', 'pending_creator', 'failed']

export async function expireRoom(roomId: string): Promise<JobResult> {
  let room = await loadRoom(roomId)
  if (!room) return
  // Never delete authorization IDs that still hold a fan's money: end the room and void every open hold first.
  if (room.status === 'draft' || room.status === 'live') await endRoom(roomId)
  room = await loadRoom(roomId)
  if (room?.status === 'ended') await settleRoom(roomId, {}, { voidAll: true })
  else if (room?.status === 'settling') await settleRoom(roomId, {})
  room = await loadRoom(roomId)
  if (!room) return
  if (room.status !== 'settled' && room.status !== 'voided') return { again: new Date(now() + RECHECK_MS) }

  if (room.status === 'settled') {
    const windowEnd = room.contest_window_ends_at ? new Date(room.contest_window_ends_at).getTime() : 0
    const keepUntil = Math.max(new Date(room.expires_at).getTime(), windowEnd + KEEP_AFTER_CONTEST_MS)
    if (keepUntil > now()) return { again: new Date(keepUntil) }
    // Receipts and contests feed the payout: wait while it is in flight or blocked on a contest decision.
    const [busy] = await db().query<{ n: number }>(
      `SELECT (SELECT count(*) FROM contests WHERE room_id = $1 AND state = ANY($2::text[]))::int
            + (SELECT count(*) FROM jobs WHERE room_id = $1 AND kind = 'close_contest_window' AND state IN ('pending', 'running'))::int AS n`,
      [roomId, PENDING_CONTESTS],
    )
    if (room.payout_state === 'pending' || Number(busy?.n ?? 0) > 0) return { again: new Date(now() + 24 * RECHECK_MS) }
  }

  stopDetector(roomId)
  await db().tx(async (q) => {
    await q.query(`DELETE FROM segments WHERE room_id = $1`, [roomId])
    await q.query(`DELETE FROM detections WHERE room_id = $1`, [roomId])
    await q.query(`DELETE FROM fans WHERE room_id = $1`, [roomId])
    await q.query(`UPDATE rooms SET title = 'Expired room' WHERE id = $1`, [roomId])
  })
}
