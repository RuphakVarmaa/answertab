// Wall clock (overridable in tests), the room clock, and the fixed windows per room kind.
import type { RoomKind } from '../../shared/types.js'

let nowFn: () => number = () => Date.now()

export const now = (): number => nowFn()
export const nowDate = (): Date => new Date(nowFn())

/** Tests only: pin or advance time. null restores Date.now. */
export function setNowForTests(fn: (() => number) | null): void {
  nowFn = fn ?? (() => Date.now())
}

const MIN = 60_000
const HOUR = 60 * MIN

/**
 * Approve deadline after End (then every tab is voided), the contest window after settlement, and the longest a
 * room stays live before it is ended for the creator (an abandoned room must not keep fans' holds open).
 */
export const WINDOWS: Record<RoomKind, { approveMs: number; contestMs: number; maxLiveMs: number }> = {
  demo: { approveMs: 30 * MIN, contestMs: 10 * MIN, maxLiveMs: 60 * MIN },
  public: { approveMs: 24 * HOUR, contestMs: 24 * HOUR, maxLiveMs: 12 * HOUR },
}
export const ROOM_TTL_MS = 7 * 24 * HOUR

/** Rooms keep their money records at least this long after the contest window closes. */
export const KEEP_AFTER_CONTEST_MS = 7 * 24 * HOUR

/** Milliseconds since the room clock started (0 before Start). */
export function roomClockMs(clockStartedAt: Date | string | null): number {
  if (!clockStartedAt) return 0
  return Math.max(0, Math.round(nowFn() - new Date(clockStartedAt).getTime()))
}

export function iso(d: Date | string | null | undefined): string | null {
  if (d === null || d === undefined) return null
  return (d instanceof Date ? d : new Date(d)).toISOString()
}
