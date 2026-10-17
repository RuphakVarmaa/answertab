// Presentation layout: the parent page holds the one creator SSE stream and relays each event to the fan
// phones (same-origin iframes) with postMessage, filtered to what that fan's own stream would carry.
import type { QuestionView, RoomEvent } from '../../shared/types.js'
import { parseRoomEvent } from './events.js'

export const RELAY_TAG = 'answertab:relay'

export type RelayMessage =
  | { tag: typeof RELAY_TAG; kind: 'event'; event: RoomEvent }
  /** The parent's stream (re)opened: reload full state. */
  | { tag: typeof RELAY_TAG; kind: 'resync' }

const redact = (q: QuestionView): QuestionView => (q.state === 'hidden' ? { ...q, text: '', askerName: '', quote: null } : q)

/** The event as this fan's own stream would carry it (server audiences in docs/contract-changes.md), or null. */
export function eventForFan(ev: RoomEvent, fanId: string): RoomEvent | null {
  switch (ev.type) {
    case 'ledger.call':
    case 'verdict':
    case 'payout.updated':
    case 'contest.updated':
      return null
    case 'tab.updated': {
      if (ev.tab.fanId !== fanId) return null
      const { displayName: _d, isBot: _b, ...tab } = ev.tab
      return { type: 'tab.updated', tab }
    }
    case 'question.created':
    case 'question.updated':
      return { ...ev, question: redact(ev.question) }
    case 'room.state':
      return Array.isArray(ev.room.questions) ? { ...ev, room: { ...ev.room, questions: ev.room.questions.map(redact) } } : ev
    default:
      return ev
  }
}

/** Validates a postMessage payload; anything that is not a well-formed relay message is null. */
export function parseRelayMessage(data: unknown): RelayMessage | null {
  if (!data || typeof data !== 'object') return null
  const m = data as Record<string, unknown>
  if (m.tag !== RELAY_TAG) return null
  if (m.kind === 'resync') return { tag: RELAY_TAG, kind: 'resync' }
  if (m.kind === 'event' && m.event && typeof m.event === 'object') {
    let json: string
    try {
      json = JSON.stringify(m.event)
    } catch {
      return null
    }
    const event = parseRoomEvent('message', json)
    return event ? { tag: RELAY_TAG, kind: 'event', event } : null
  }
  return null
}
