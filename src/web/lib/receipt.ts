// What one receipt line says. Until the creator settles, a line is a reservation, not a charge or a release.
import type { ReceiptLine, RoomStatus, TabState } from '../../shared/types.js'
import type { Tone } from './cardState.js'

export type LineKind = 'reserved' | 'charged' | 'refunded' | 'late' | 'unpaid'

export interface LineStatus {
  kind: LineKind
  label: string
  icon: string
  tone: Tone
  /** The line counts as charged (amount shown, contest allowed). */
  charged: boolean
}

/** The server may send chargeCents null until settled, plus a per-line status. */
export type ReceiptLineIn = Omit<ReceiptLine, 'chargeCents'> & { chargeCents: number | null; status?: string | null }

const OPEN_ROOM: ReadonlySet<string> = new Set(['draft', 'live', 'ended', 'settling'])
const SETTLED_TAB: ReadonlySet<string> = new Set(['captured', 'voided', 'failed', 'declined'])

export function lineStatus(line: ReceiptLineIn, ctx: { roomStatus?: RoomStatus | string | null; tabState?: TabState | null } = {}): LineStatus {
  const reserved =
    line.status === 'reserved' ||
    line.chargeCents === null ||
    (!line.status && !!ctx.roomStatus && OPEN_ROOM.has(ctx.roomStatus) && !(ctx.tabState && SETTLED_TAB.has(ctx.tabState)))
  if (reserved) return { kind: 'reserved', label: 'Reserved — decided when the creator settles', icon: 'clock', tone: 'info', charged: false }
  const cents = line.chargeCents ?? 0
  if (line.status === 'refunded') return { kind: 'refunded', label: 'Refunded', icon: 'undo', tone: 'info', charged: cents > 0 }
  if (cents > 0) return { kind: 'charged', label: line.rating === 'half' ? 'Partial answer, half' : 'Answered', icon: 'checkCircle', tone: 'ok', charged: true }
  if (line.rating === 'full' || line.rating === 'half') return { kind: 'late', label: 'Joined after the answer — not charged', icon: 'slash', tone: 'muted', charged: false }
  return { kind: 'unpaid', label: line.rating === 'none' ? 'Rated not answered' : 'Not answered — not charged', icon: 'slash', tone: 'muted', charged: false }
}
