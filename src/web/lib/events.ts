// SSE event parsing and state reducers. Pure, so reconnect/reload logic is testable in node.
import type { ConsoleView, FanSelfView, QuestionView, RoomEvent, RoomView, Segment } from '../../shared/types.js'

export const EVENT_TYPES = [
  'room.state',
  'question.created',
  'question.updated',
  'backing.created',
  'tab.updated',
  'segment.added',
  'segment.interim',
  'verdict',
  'settle.progress',
  'ledger.call',
  'contest.updated',
  'payout.updated',
  'budget.mode',
] as const satisfies readonly RoomEvent['type'][]

const KNOWN = new Set<string>(EVENT_TYPES)

/**
 * Accepts both SSE styles: unnamed `message` events whose JSON carries `type`, and named events
 * (`event: question.updated`) whose JSON may omit it. Anything else is dropped.
 */
export function parseRoomEvent(eventName: string, data: string): RoomEvent | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  const type = typeof obj.type === 'string' ? obj.type : eventName
  if (!KNOWN.has(type)) return null
  return { ...obj, type } as RoomEvent
}

/** Replace by key, or append. Keeps array identity when nothing changed shape-wise is not needed here. */
export function upsertBy<T>(list: readonly T[], item: T, key: (t: T) => string | number): T[] {
  const k = key(item)
  const i = list.findIndex((x) => key(x) === k)
  if (i === -1) return [...list, item]
  const next = list.slice()
  next[i] = item
  return next
}

function upsertQuestion(room: RoomView, q: QuestionView): RoomView {
  return { ...room, questions: upsertBy(room.questions, q, (x) => x.id) }
}

export function applyRoomEvent(room: RoomView, ev: RoomEvent): RoomView {
  switch (ev.type) {
    case 'room.state':
      // Some servers send room.state without questions; keep ours then.
      return { ...ev.room, questions: Array.isArray(ev.room.questions) ? ev.room.questions : room.questions }
    case 'question.created':
    case 'question.updated':
      return upsertQuestion(room, ev.question)
    case 'backing.created':
      return {
        ...room,
        questions: room.questions.map((q) => (q.id === ev.questionId ? { ...q, backers: ev.backers, backedCents: ev.backedCents } : q)),
      }
    case 'budget.mode':
      return { ...room, aiMode: ev.mode }
    case 'payout.updated':
      return { ...room, payoutState: ev.payout.state }
    default:
      return room
  }
}

const bySeq = (a: Segment, b: Segment) => a.seq - b.seq

export function applyConsoleEvent(view: ConsoleView, ev: RoomEvent): ConsoleView {
  switch (ev.type) {
    case 'tab.updated': {
      const prev = view.tabs.find((t) => t.id === ev.tab.id)
      const tab = {
        ...ev.tab,
        displayName: ev.tab.displayName ?? prev?.displayName ?? 'Fan',
        isBot: ev.tab.isBot ?? prev?.isBot ?? false,
      }
      return { ...view, tabs: upsertBy(view.tabs, tab, (t) => t.id) }
    }
    case 'segment.added':
      return { ...view, segments: upsertBy(view.segments, ev.segment, (s) => s.seq).sort(bySeq) }
    case 'ledger.call': {
      const ledger = upsertBy(view.ledger, ev.call, (c) => c.id).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      return { ...view, ledger }
    }
    case 'contest.updated':
      return { ...view, contests: upsertBy(view.contests, ev.contest, (c) => c.id) }
    case 'payout.updated':
      return { ...view, payout: ev.payout, room: applyRoomEvent(view.room, ev) }
    default:
      return { ...view, room: applyRoomEvent(view.room, ev) }
  }
}

export interface FanState {
  room: RoomView
  me: FanSelfView | null
}

export function applyFanEvent(state: FanState, ev: RoomEvent): FanState {
  if (ev.type === 'tab.updated') {
    const me = state.me
    if (!me || ev.tab.fanId !== me.fanId) return state
    const { displayName: _d, isBot: _b, ...tab } = ev.tab
    return { ...state, me: { ...me, tab } }
  }
  return { ...state, room: applyRoomEvent(state.room, ev) }
}

/**
 * Events that arrive while a full reload is in flight are buffered and replayed on top of the fresh
 * snapshot, so a slow reload never rolls the screen back.
 */
export function replayOnto<S>(snapshot: S, buffered: readonly RoomEvent[], apply: (s: S, e: RoomEvent) => S): S {
  return buffered.reduce(apply, snapshot)
}

/** Reconnect delay: 1 s, 2 s, 4 s ... capped at 15 s, with up to 20% jitter subtracted. */
export function backoffMs(attempt: number, rand: number = Math.random()): number {
  const base = Math.min(15_000, 1000 * 2 ** Math.max(0, attempt))
  return Math.round(base * (1 - 0.2 * Math.min(1, Math.max(0, rand))))
}
