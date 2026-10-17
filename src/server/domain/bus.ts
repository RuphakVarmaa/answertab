// In-process room event bus. The SSE hub subscribes; domain code publishes with an audience.
import type { RoomEvent } from '../../shared/types.js'

/** all: creator, fans and anonymous viewers. creator: the console only. fan: that one fan. others: everyone but the creator. */
export type Audience = { to: 'all' } | { to: 'creator' } | { to: 'fan'; fanId: string } | { to: 'others' }

export const ALL: Audience = { to: 'all' }
export const CREATOR: Audience = { to: 'creator' }
export const OTHERS: Audience = { to: 'others' }
export const toFan = (fanId: string): Audience => ({ to: 'fan', fanId })

export type BusListener = (roomId: string, event: RoomEvent, audience: Audience) => void
const listeners = new Set<BusListener>()

export function onRoomEvent(l: BusListener): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function emit(roomId: string, event: RoomEvent, audience: Audience = ALL): void {
  for (const l of listeners) {
    try {
      l(roomId, event, audience)
    } catch (e) {
      console.warn(`[bus] listener failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}
