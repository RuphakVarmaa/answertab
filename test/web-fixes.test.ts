// Regression tests for the 2026-10-16 review (docs/review-2026-10-16.md, judge findings on the web app).
import { describe, expect, it } from 'vitest'
import type { QuestionView, ReviewItem, RoomEvent, Segment, StatusCheck, TabView } from '../src/shared/types.js'
import { api, normalizeRecordedRun, normalizeSettle, normalizeVerify } from '../src/web/lib/api.js'
import { LATE_LABEL, cardStatus, isLateBacking, type BackingIn } from '../src/web/lib/cardState.js'
import { disputeIsOpen, evidenceFileName, humanize, summarizeEvidence } from '../src/web/lib/disputes.js'
import { spaceStartsTalk } from '../src/web/lib/keys.js'
import { friendlyError } from '../src/web/lib/messages.js'
import { lineStatus, type ReceiptLineIn } from '../src/web/lib/receipt.js'
import { RELAY_TAG, eventForFan, parseRelayMessage } from '../src/web/lib/relay.js'
import { REPLAY_LINES, replayProgress, type ReplayInput } from '../src/web/lib/replay.js'
import { resultsTotals } from '../src/web/lib/results.js'
import { defaultRatings, isChargeable, isPending, liveReview, settleRatings } from '../src/web/lib/review.js'
import { moveWord } from '../src/web/lib/spans.js'
import { checkLabel, paypalDegraded } from '../src/web/lib/statusChecks.js'

const q = (n: number, state: QuestionView['state'], extra: Partial<QuestionView> = {}): QuestionView => ({
  id: `q${n}`,
  number: n,
  text: `Question ${n}`,
  askerName: 'Asha',
  state,
  backers: 3,
  backedCents: 1200,
  similarTo: null,
  askedAtMs: 5000,
  quote: state === 'open' ? null : 'one router file per feature',
  quoteAtMs: state === 'open' ? null : 20_000,
  quoteSource: state === 'open' ? null : 'typed',
  creatorConfirmed: false,
  confidence: 0.95,
  rating: null,
  ...extra,
})
const item = (n: number, state: ReviewItem['state'], lockedCents = 1200): ReviewItem => ({
  questionNumber: n,
  questionId: `q${n}`,
  text: `Question ${n}`,
  state,
  quote: state === 'open' ? null : 'one router file per feature',
  confidence: 0.95,
  verdict: null,
  backers: 3,
  lockedCents,
})
const tab = (fanId: string, state: TabView['state'], extra: Partial<TabView> = {}): TabView & { displayName: string; isBot: boolean } => ({
  id: `t-${fanId}`,
  fanId,
  ceilingCents: 1000,
  reservedCents: 0,
  funding: 'bot_card',
  state,
  authStatus: null,
  orderId: null,
  authorizationId: null,
  captureId: null,
  capturedCents: 0,
  releasedCents: 0,
  feeCents: null,
  refundedCents: 0,
  receiptToken: null,
  declineReason: null,
  displayName: fanId,
  isBot: true,
  ...extra,
})

describe('F2: the review list follows verdicts that land after End', () => {
  it('a card still verifying at End is pending (not "released"), and Settle waits for it', () => {
    const atEnd = [item(1, 'verifying')]
    const live = liveReview(atEnd, [q(1, 'verifying')])!
    expect(live.filter(isChargeable)).toHaveLength(0)
    expect(live.filter(isPending)).toHaveLength(1)
  })

  it('when the verifier then locks it, the list shows the lock and the settle body rates it explicitly', () => {
    const atEnd = [item(1, 'verifying')]
    const live = liveReview(atEnd, [q(1, 'locked')])!
    expect(live[0]!.state).toBe('locked')
    expect(live.filter(isChargeable)).toHaveLength(1)
    expect(settleRatings(live, defaultRatings(live))).toEqual({ 1: 'full' })
  })

  it('a late verdict sent to review starts unrated, so it is not charged unless the creator rates it', () => {
    const live = liveReview([item(1, 'open', 0)], [q(1, 'review')])!
    expect(live[0]).toMatchObject({ state: 'review', lockedCents: 1200 })
    expect(settleRatings(live, defaultRatings(live))).toEqual({ 1: 'none' })
  })

  it('a lock the server marks chargedByDefault: false needs an explicit rating', () => {
    const items = [{ ...item(1, 'locked'), chargedByDefault: false }, { ...item(2, 'locked'), chargedByDefault: true }]
    expect(defaultRatings(items)).toEqual({ 1: null, 2: 'full' })
    expect(settleRatings(items, defaultRatings(items))).toEqual({ 1: 'none', 2: 'full' })
  })

  it('keeps the server lockedCents, drops hidden cards and appends cards the snapshot missed', () => {
    const live = liveReview([item(1, 'locked', 900), item(2, 'open', 0)], [q(1, 'locked'), q(2, 'hidden'), q(3, 'open')])!
    expect(live.map((i) => [i.questionNumber, i.state, i.lockedCents])).toEqual([
      [1, 'locked', 900],
      [3, 'open', 1200],
    ])
    expect(liveReview(null, [q(1, 'locked')])).toBeNull()
  })
})

describe('F14: the replay indicator follows the director, not a timer', () => {
  const base = (p: Partial<ReplayInput>): ReplayInput => ({ status: 'live', segments: [], tabs: [], questions: [], interim: false, clockMs: 5000, ...p })
  const seg = (tEndMs: number, source: Segment['source'] = 'replay') => ({ source, final: true, tEndMs })
  const bots = (state: TabView['state']) => [tab('a', state), tab('b', state)]

  it('says the bots are placing holds, then that the replay is starting', () => {
    expect(replayProgress(base({ tabs: bots('opening') })).phase).toBe('holds')
    expect(replayProgress(base({ tabs: bots('held') }))).toMatchObject({ phase: 'waiting', label: 'Replay starting' })
  })

  it('counts replay lines and stays "playing" through the gaps and while Claude checks', () => {
    expect(replayProgress(base({ tabs: bots('held'), interim: true })).label).toBe(`Replay 1/${REPLAY_LINES} playing`)
    const one = replayProgress(base({ segments: [seg(15_000)], clockMs: 22_000 }))
    expect(one).toMatchObject({ phase: 'playing', step: 1, active: true })
    const checking = replayProgress(base({ segments: [seg(15_000), seg(24_000)], questions: [q(1, 'verifying')], clockMs: 30_000 }))
    expect(checking).toMatchObject({ phase: 'checking', step: 2, active: true })
  })

  it('hands over only after the last line, once nothing is verifying', () => {
    const segs = [seg(15_000), seg(24_000), seg(31_000), seg(40_000, 'typed')]
    expect(replayProgress(base({ segments: segs, questions: [q(2, 'verifying')], clockMs: 33_000 })).phase).toBe('checking')
    expect(replayProgress(base({ segments: segs, questions: [q(2, 'review')], clockMs: 33_000 }))).toMatchObject({ phase: 'done', label: 'Replay done — your turn' })
  })

  it('reads "finished" (never "your turn") once the room is not live, and survives a reload', () => {
    expect(replayProgress(base({ status: 'ended', segments: [seg(15_000)] })).label).toBe('Replay finished')
    expect(replayProgress(base({ status: 'draft' })).phase).toBe('idle')
  })

  it('treats a director that went quiet as done', () => {
    expect(replayProgress(base({ segments: [seg(15_000)], clockMs: 15_000 + 30_000 })).phase).toBe('done')
  })
})

describe('F6: receipt lines during the stream are reservations', () => {
  const line = (p: Partial<ReceiptLineIn>): ReceiptLineIn => ({
    backingId: 'b1',
    questionNumber: 1,
    questionText: 'Q',
    kind: 'metoo',
    amountCents: 300,
    chargeCents: 0,
    rating: null,
    quote: null,
    quoteAtMs: null,
    quoteSource: null,
    creatorConfirmed: false,
    contest: null,
    ...p,
  })

  it('never says "not charged … released" before settlement', () => {
    expect(lineStatus(line({ chargeCents: null }), {}).kind).toBe('reserved')
    expect(lineStatus(line({ status: 'reserved', chargeCents: 0 }), {}).kind).toBe('reserved')
    // Older servers: chargeCents 0 while live; the room status decides.
    expect(lineStatus(line({}), { roomStatus: 'live', tabState: 'held' })).toMatchObject({ kind: 'reserved', charged: false })
    expect(lineStatus(line({}), { roomStatus: 'settling', tabState: 'settling' }).kind).toBe('reserved')
  })

  it('after settlement reads charged, released, or late', () => {
    expect(lineStatus(line({ chargeCents: 300, rating: 'full', status: 'charged' }), { roomStatus: 'settled', tabState: 'captured' })).toMatchObject({ kind: 'charged', charged: true })
    expect(lineStatus(line({ chargeCents: 0, status: 'released' }), { roomStatus: 'settled', tabState: 'voided' }).label).toBe('Not answered — not charged')
    expect(lineStatus(line({ chargeCents: 0, rating: 'full', status: 'released' }), { roomStatus: 'settled', tabState: 'captured' }).label).toBe(LATE_LABEL)
  })
})

describe('F13: verify shows what PayPal disagrees with', () => {
  const server = {
    checkedAt: '2026-10-16T12:00:00.000Z',
    authorization: { id: 'AUTH1', status: 'EXPIRED', amountCents: 1000 },
    capture: null,
    matches: false,
    mismatches: ['Authorization is EXPIRED at PayPal; the receipt shows a hold'],
    receipt: null,
  }

  it('passes matches and mismatches through', () => {
    const v = normalizeVerify(server)
    expect(v).toMatchObject({ matches: false, verifiedAt: server.checkedAt })
    expect(v.mismatches).toEqual(server.mismatches)
    expect(v.records).toEqual([{ kind: 'authorization', id: 'AUTH1', status: 'EXPIRED', amountCents: 1000 }])
  })

  it('a green check needs matches: true and no mismatches; no field means unknown', () => {
    expect(normalizeVerify({ ...server, matches: true, mismatches: [] }).matches).toBe(true)
    expect(normalizeVerify({ ...server, matches: true, mismatches: ['x'] }).matches).toBe(false)
    expect(normalizeVerify({ authorization: { id: 'A', status: 'CREATED' } }).matches).toBeNull()
  })
})

describe('F17: settle response errors', () => {
  it('reads errors[] and the room status, tolerating older bodies', () => {
    const r = normalizeSettle({ room: { status: 'settling' }, tabs: [], errors: [{ tabId: 't1', message: 'PayPal 503' }, { bad: true }] })
    expect(r.room?.status).toBe('settling')
    expect(r.errors).toEqual([{ tabId: 't1', message: 'PayPal 503' }])
    expect(normalizeSettle(null)).toEqual({ room: null, tabs: [], errors: [] })
  })
})

describe('F10: recorded-run fallback', () => {
  it('reads the server lastPassedRun steps', () => {
    const run = normalizeRecordedRun({
      id: 'syn_1',
      finishedAt: '2026-10-16T10:00:00.000Z',
      roomId: 'r1',
      steps: [
        { name: 'Asha: hold', paypalId: 'AUTH-A', status: 'CAPTURED' },
        { name: 'Asha: capture', paypalId: 'CAP-A', status: 'captured' },
        { name: 'Dev: hold', paypalId: null, status: 'DENIED' },
        { name: 'creator payout', paypalId: 'BATCH-1', status: 'SUCCESS' },
      ],
      timings: {},
    })!
    expect(run.finishedAt).toBe('2026-10-16T10:00:00.000Z')
    expect(run.steps.map((x) => x.paypalId)).toEqual(['AUTH-A', 'CAP-A', 'BATCH-1'])
  })

  it('also reads a raw synthetic details.paypal, and nothing when there are no IDs', () => {
    const paypal = { tabs: [{ fan: 'Ben', state: 'captured', authStatus: 'CAPTURED', authorizationId: 'AUTH-B', captureId: 'CAP-B' }], refund: { refundId: 'REF-1', state: 'refunded' }, payout: null }
    expect(normalizeRecordedRun({ finished_at: 'x', details: { paypal } })?.steps.map((x) => x.name)).toEqual(['Ben: hold', 'Ben: capture', 'contest refund'])
    expect(normalizeRecordedRun(null)).toBeNull()
    expect(normalizeRecordedRun({ steps: [] })).toBeNull()
  })

  it('shows only when a PayPal check a demo needs is failing (webhooks only reconcile)', () => {
    const c = (name: string, ok: boolean): StatusCheck => ({ name, ok, detail: '', checkedAt: '' })
    expect(paypalDegraded([c('paypal_oauth', false)])).toBe(true)
    expect(paypalDegraded([c('paypal_webhook', false), c('anthropic', false)])).toBe(false)
    expect(paypalDegraded(null)).toBe(false)
    expect(checkLabel('paypal_oauth')).toBe('PayPal sign-in')
  })
})

describe('F15: judge code and room limit errors are explicit', () => {
  it('keeps the room_limit message and names a bad judge code', () => {
    const msg = 'This network has opened 20 rooms today. Try again tomorrow, or use the judge code.'
    expect(friendlyError({ code: 'room_limit', status: 429, message: msg })).toBe(msg)
    expect(friendlyError({ code: 'bad_judge_code', status: 403, message: 'x' })).toMatch(/judge code wasn't recognized/)
    expect(friendlyError({ code: 'http_403', status: 403, message: 'x' })).toMatch(/key/)
  })
})

describe('F23: Results net includes refunds', () => {
  const tabs = [tab('a', 'captured', { capturedCents: 600, feeCents: 50, refundedCents: 300 }), tab('b', 'captured', { capturedCents: 900, feeCents: 65 })]
  it('subtracts refunds client-side', () => {
    expect(resultsTotals({ tabs })).toMatchObject({ grossCents: 1500, feeCents: 115, refundedCents: 300, netCents: 1085, fromServer: false })
  })
  it('prefers the server totals when present', () => {
    expect(resultsTotals({ tabs, totals: { grossCents: 1500, feeCents: 115, refundedCents: 300, netCents: 1080 } })).toMatchObject({ netCents: 1080, fromServer: true })
    expect(resultsTotals({ tabs, totals: { grossCents: 1500 } }).fromServer).toBe(false)
  })
})

describe('F16: one SSE connection, relayed to the phones', () => {
  const ev = (e: RoomEvent) => e
  it('passes each phone only what its own fan stream would carry', () => {
    const t = ev({ type: 'tab.updated', tab: { ...tab('ben', 'held'), displayName: 'Ben', isBot: true } })
    expect(eventForFan(t, 'asha')).toBeNull()
    const mine = eventForFan(t, 'ben')
    expect(mine).toMatchObject({ type: 'tab.updated', tab: { fanId: 'ben' } })
    expect((mine as Extract<RoomEvent, { type: 'tab.updated' }>).tab).not.toHaveProperty('displayName')
    expect(eventForFan(ev({ type: 'ledger.call', call: {} as never }), 'ben')).toBeNull()
    expect(eventForFan(ev({ type: 'verdict', questionNumber: 1, action: 'lock', quote: 'x', reason: '' }), 'ben')).toBeNull()
    const hidden = eventForFan(ev({ type: 'question.updated', question: q(2, 'hidden', { text: 'secret' }) }), 'ben')
    expect((hidden as Extract<RoomEvent, { type: 'question.updated' }>).question).toMatchObject({ text: '', askerName: '', quote: null })
    expect(eventForFan(ev({ type: 'segment.interim', text: 'hi' }), 'ben')).toEqual({ type: 'segment.interim', text: 'hi' })
  })

  it('accepts only well-formed relay messages', () => {
    expect(parseRelayMessage({ tag: RELAY_TAG, kind: 'resync' })).toEqual({ tag: RELAY_TAG, kind: 'resync' })
    expect(parseRelayMessage({ tag: RELAY_TAG, kind: 'event', event: { type: 'segment.interim', text: 'x' } })?.kind).toBe('event')
    expect(parseRelayMessage({ tag: RELAY_TAG, kind: 'event', event: { type: 'evil' } })).toBeNull()
    expect(parseRelayMessage({ tag: 'other', kind: 'resync' })).toBeNull()
    expect(parseRelayMessage('resync')).toBeNull()
  })

  it('SSE URLs carry the token once, never the k=/t= aliases', () => {
    expect(api.eventsUrl('r1', { creator: 'SECRET' })).toBe('/api/rooms/r1/events?token=SECRET&role=creator')
    expect(api.eventsUrl('r1', { fan: 'FAN' })).not.toMatch(/[?&]t=/)
  })
})

describe('F25: a late backer is never shown "$3 locked"', () => {
  const b = (extra: Partial<BackingIn>): BackingIn => ({ id: 'b', questionId: 'q1', questionNumber: 1, kind: 'metoo', amountCents: 300, chargeCents: null, state: 'reserved', ...extra })
  it('uses the server flag, else the backing time against the answer start', () => {
    expect(isLateBacking(b({ chargeable: false }), { quoteAtMs: null })).toBe(true)
    expect(isLateBacking(b({ backedAtMs: 21_000 }), { quoteAtMs: 20_000 })).toBe(true)
    expect(isLateBacking(b({ backedAtMs: 19_000 }), { quoteAtMs: 20_000 })).toBe(false)
    expect(isLateBacking(b({}), { quoteAtMs: 20_000 })).toBe(false)
  })
  it('the card says so', () => {
    expect(cardStatus(q(1, 'locked'), { myCents: 300, late: true })).toMatchObject({ label: LATE_LABEL, locked: false, tone: 'muted' })
    expect(cardStatus(q(1, 'locked'), { myCents: 300 }).label).toBe('Answered — $3 locked')
    expect(cardStatus(q(1, 'open'), { late: true }).label).toBe('Open')
  })
})

describe('F19: keyboard', () => {
  const el = (tagName: string, inControl = false) => ({ tagName, closest: () => (inControl ? {} : null) })
  it('Space talks only on the talk button or on no control', () => {
    const ptt = el('BUTTON')
    const body = el('BODY')
    expect(spaceStartsTalk(ptt, ptt, body)).toBe(true)
    expect(spaceStartsTalk(body, ptt, body)).toBe(true)
    expect(spaceStartsTalk(el('DIV'), ptt, body)).toBe(true)
    expect(spaceStartsTalk(el('BUTTON'), ptt, body)).toBe(false)
    expect(spaceStartsTalk(el('INPUT'), ptt, body)).toBe(false)
    expect(spaceStartsTalk(el('TEXTAREA'), ptt, body)).toBe(false)
    expect(spaceStartsTalk(el('SPAN', true), ptt, body)).toBe(false)
    expect(spaceStartsTalk({ tagName: 'DIV', isContentEditable: true }, ptt, body)).toBe(false)
  })

  it('arrow keys walk words across segments', () => {
    const segs = [
      { seq: 1, words: ['Okay', 'folders:'], final: true },
      { seq: 2, words: ['one', 'router', 'file'], final: true },
      { seq: 3, words: ['x'], final: false },
    ]
    expect(moveWord(segs, null, 'next')).toEqual({ seg: 2, word: 2 })
    expect(moveWord(segs, { seg: 1, word: 1 }, 'next')).toEqual({ seg: 2, word: 0 })
    expect(moveWord(segs, { seg: 2, word: 0 }, 'prev')).toEqual({ seg: 1, word: 1 })
    expect(moveWord(segs, { seg: 1, word: 0 }, 'prev')).toEqual({ seg: 1, word: 0 })
    expect(moveWord(segs, { seg: 1, word: 1 }, 'nextSeg')).toEqual({ seg: 2, word: 0 })
    expect(moveWord(segs, { seg: 2, word: 1 }, 'first')).toEqual({ seg: 1, word: 0 })
    expect(moveWord([], null, 'last')).toBeNull()
  })
})

describe('F9: dispute evidence pack', () => {
  const pack = {
    dispute: { id: 'PP-D-1', status: 'OPEN', sellerResponseDueDate: '2026-10-30T00:00:00Z' },
    generatedAt: '2026-10-16T12:00:00Z',
    room: { id: 'r1', title: 'Office hours' },
    tab: { id: 't1', orderId: 'O1', authorizationId: 'A1', captureId: 'C1', holdCents: 1000, capturedCents: 600, refundedCents: 0 },
    lines: [{ questionNumber: 1, question: 'Folders?', kind: 'ask', amountCents: 600, chargeCents: 600, quote: 'one router file per feature', quoteAtMs: 20000, quoteSource: 'replay', creatorConfirmed: false }],
    contests: [{ id: 'c1', state: 'upheld', finding: 'answered', refundId: null, refundCents: null }],
  }
  it('summarizes the pack for the readable view', () => {
    const s = summarizeEvidence(pack)!
    expect(s.ids.map((i) => i.label)).toEqual(['Dispute', 'Order', 'Authorization', 'Capture'])
    expect(s.lines[0]).toMatchObject({ questionNumber: 1, chargeCents: 600, quote: 'one router file per feature' })
    expect(s.contests).toHaveLength(1)
    expect(summarizeEvidence(null)).toBeNull()
  })
  it('labels and names the download safely', () => {
    expect(humanize('MERCHANDISE_OR_SERVICE_NOT_RECEIVED')).toBe('Merchandise or service not received')
    expect(disputeIsOpen({ status: 'RESOLVED' })).toBe(false)
    expect(disputeIsOpen({ status: 'WAITING_FOR_SELLER_RESPONSE' })).toBe(true)
    expect(evidenceFileName({ id: 'PP-D-1/../x' })).toBe('answertab-evidence-PP-D-1x.json')
  })
})
