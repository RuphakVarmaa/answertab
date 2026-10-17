import { describe, expect, it } from 'vitest'
import type { ConsoleView, LedgerCallView, QuestionView, RoomEvent, RoomView, TabView } from '../src/shared/types.js'
import { applyConsoleEvent, applyFanEvent, applyRoomEvent, backoffMs, parseRoomEvent, replayOnto, upsertBy } from '../src/web/lib/events.js'

const Q: QuestionView = {
  id: 'q1',
  number: 1,
  text: 'Folders?',
  askerName: 'Maya',
  state: 'open',
  backers: 1,
  backedCents: 600,
  similarTo: null,
  askedAtMs: 0,
  quote: null,
  quoteAtMs: null,
  quoteSource: null,
  creatorConfirmed: false,
  confidence: null,
  rating: null,
}

const ROOM: RoomView = {
  id: 'r1',
  title: 'Office hours',
  kind: 'demo',
  status: 'live',
  prices: { questionCents: 600, metooCents: 300, ceilingsCents: [1000], platformFeeBps: 500 },
  language: 'en-US',
  aiMode: 'ai',
  clockStartedAt: null,
  endedAt: null,
  contestWindowEndsAt: null,
  payoutState: 'none',
  questions: [Q],
}

const TAB: TabView = {
  id: 't1',
  fanId: 'f1',
  ceilingCents: 1000,
  reservedCents: 600,
  funding: 'bot_card',
  state: 'held',
  authStatus: 'CREATED',
  orderId: 'O',
  authorizationId: 'A',
  captureId: null,
  capturedCents: 0,
  releasedCents: 0,
  feeCents: null,
  refundedCents: 0,
  receiptToken: null,
  declineReason: null,
}

const call = (id: string, at: string): LedgerCallView => ({
  id,
  at,
  op: 'capture_authorization',
  method: 'POST',
  endpoint: '/v2/payments/authorizations/A/capture',
  requestId: `settle-r1-${id}`,
  httpStatus: 201,
  resourceId: `C-${id}`,
  resourceStatus: 'COMPLETED',
  debugId: 'dbg',
  latencyMs: 300,
  tabId: 't1',
})

const CONSOLE: ConsoleView = { room: ROOM, segments: [], tabs: [{ ...TAB, displayName: 'Maya', isBot: true }], ledger: [], contests: [], payout: null, llmSpentMicros: 0 }

describe('parseRoomEvent', () => {
  it('reads unnamed events whose JSON carries the type', () => {
    expect(parseRoomEvent('message', JSON.stringify({ type: 'segment.interim', text: 'hi' }))).toEqual({ type: 'segment.interim', text: 'hi' })
  })
  it('reads named events whose JSON omits the type', () => {
    expect(parseRoomEvent('settle.progress', JSON.stringify({ done: 1, total: 3 }))).toEqual({ type: 'settle.progress', done: 1, total: 3 })
  })
  it('drops junk, unknown types and non-objects', () => {
    expect(parseRoomEvent('message', 'not json')).toBeNull()
    expect(parseRoomEvent('message', JSON.stringify({ type: 'evil.event' }))).toBeNull()
    expect(parseRoomEvent('message', '[1,2]')).toBeNull()
    expect(parseRoomEvent('message', 'null')).toBeNull()
    expect(parseRoomEvent('heartbeat', '{}')).toBeNull()
  })
})

describe('room reducers', () => {
  it('upserts questions and applies backing counts', () => {
    const created = applyRoomEvent(ROOM, { type: 'question.created', question: { ...Q, id: 'q2', number: 2 } })
    expect(created.questions.map((x) => x.id)).toEqual(['q1', 'q2'])
    const updated = applyRoomEvent(created, { type: 'question.updated', question: { ...Q, state: 'locked', quote: 'one router file' } })
    expect(updated.questions[0]!.state).toBe('locked')
    const backed = applyRoomEvent(updated, { type: 'backing.created', questionId: 'q1', backers: 3, backedCents: 1200 })
    expect(backed.questions[0]).toMatchObject({ backers: 3, backedCents: 1200, state: 'locked' })
    expect(ROOM.questions).toHaveLength(1) // pure
  })

  it('keeps questions when room.state arrives without them, and tracks AI mode', () => {
    const next = applyRoomEvent(ROOM, { type: 'room.state', room: { ...ROOM, status: 'ended', questions: undefined as unknown as QuestionView[] } })
    expect(next.status).toBe('ended')
    expect(next.questions).toHaveLength(1)
    expect(applyRoomEvent(ROOM, { type: 'budget.mode', mode: 'manual', reason: 'budget' }).aiMode).toBe('manual')
  })

  it('keeps a tab\'s name when tab.updated omits it, sorts segments and ledger', () => {
    let v = applyConsoleEvent(CONSOLE, { type: 'tab.updated', tab: { ...TAB, state: 'captured', capturedCents: 600 } })
    expect(v.tabs[0]).toMatchObject({ displayName: 'Maya', isBot: true, state: 'captured' })
    v = applyConsoleEvent(v, { type: 'tab.updated', tab: { ...TAB, id: 't2', fanId: 'f2' } })
    expect(v.tabs[1]).toMatchObject({ displayName: 'Fan', isBot: false })

    const s = (seq: number) => ({ seq, text: 'x', words: ['x'], tStartMs: 0, tEndMs: 0, source: 'typed' as const, final: true })
    v = applyConsoleEvent(v, { type: 'segment.added', segment: s(2) })
    v = applyConsoleEvent(v, { type: 'segment.added', segment: s(1) })
    v = applyConsoleEvent(v, { type: 'segment.added', segment: s(2) })
    expect(v.segments.map((x) => x.seq)).toEqual([1, 2])

    v = applyConsoleEvent(v, { type: 'ledger.call', call: call('a', '2026-10-16T10:00:00Z') })
    v = applyConsoleEvent(v, { type: 'ledger.call', call: call('b', '2026-10-16T10:00:05Z') })
    expect(v.ledger.map((c) => c.id)).toEqual(['b', 'a'])
  })

  it('payout.updated sets the payout and the room\'s payout state', () => {
    const v = applyConsoleEvent(CONSOLE, { type: 'payout.updated', payout: { state: 'success', amountCents: 1102, feeCents: 25, payoutBatchId: 'B', batchStatus: 'SUCCESS', webhookSeen: true } })
    expect(v.payout?.state).toBe('success')
    expect(v.room.payoutState).toBe('success')
  })

  it('a fan only takes its own tab updates', () => {
    const state = { room: ROOM, me: { fanId: 'f1', displayName: 'Maya', tab: null, backings: [] } }
    const mine = applyFanEvent(state, { type: 'tab.updated', tab: { ...TAB, displayName: 'Maya', isBot: true } })
    expect(mine.me?.tab?.id).toBe('t1')
    expect(mine.me?.tab).not.toHaveProperty('displayName')
    const other = applyFanEvent(state, { type: 'tab.updated', tab: { ...TAB, fanId: 'f9' } })
    expect(other).toBe(state)
  })
})

describe('reload + buffered events', () => {
  it('replays events that arrived during a reload onto the fresh snapshot', () => {
    const buffered: RoomEvent[] = [
      { type: 'question.updated', question: { ...Q, state: 'verifying' } },
      { type: 'question.updated', question: { ...Q, state: 'locked' } },
    ]
    expect(replayOnto(ROOM, buffered, applyRoomEvent).questions[0]!.state).toBe('locked')
    expect(replayOnto(ROOM, [], applyRoomEvent)).toBe(ROOM)
  })

  it('upsertBy replaces in place and appends new keys', () => {
    expect(upsertBy([{ k: 1, v: 'a' }], { k: 1, v: 'b' }, (x) => x.k)).toEqual([{ k: 1, v: 'b' }])
    expect(upsertBy([{ k: 1, v: 'a' }], { k: 2, v: 'c' }, (x) => x.k)).toHaveLength(2)
  })

  it('backs off 1 s, 2 s, 4 s ... capped at 15 s, jitter only shortens', () => {
    expect(backoffMs(0, 0)).toBe(1000)
    expect(backoffMs(1, 0)).toBe(2000)
    expect(backoffMs(2, 0)).toBe(4000)
    expect(backoffMs(10, 0)).toBe(15000)
    expect(backoffMs(10, 1)).toBe(12000)
    for (let i = 0; i < 20; i++) expect(backoffMs(i, Math.random())).toBeLessThanOrEqual(15000)
  })
})
