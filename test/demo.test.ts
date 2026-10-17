// The replay director on in-memory PGlite with the fixture-shaped fake PayPal and the routed fake Claude.
// The director's clock is the pinned test clock: its sleeps advance time instead of waiting.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RoomEvent } from '../src/shared/types.js'

vi.mock('../src/server/paypal/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/server/paypal/index.js')>()
  const { makeFakePayPal } = await import('../src/server/domain/testkit.js')
  return { ...actual, ...makeFakePayPal(actual) }
})

import * as paypal from '../src/server/paypal/index.js'
import { resetConfigForTests } from '../src/server/config.js'
import { openDb, setDb, type Db } from '../src/server/db/db.js'
import { setAnthropicClientForTests } from '../src/server/ai/index.js'
import {
  addSegment,
  endRoom,
  getConsoleView,
  initDomain,
  onRoomEvent,
  pointSpan,
  setNowForTests,
  settleRoom,
  stopAllDetectors,
  type Audience,
} from '../src/server/domain/index.js'
import { routedClaude, type DetectRule, type FakePayPalState, type RoutedClaudeOptions } from '../src/server/domain/testkit.js'
import { demoDirectorDone, demoTabsReady, setDemoDirector, startDemoRoom } from '../src/server/demo/index.js'
import { runDirector, type DirectorClock, type DirectorOptions, type DirectorReport } from '../src/server/demo/director.js'
import { AUTOPLAY_BUDGET_MS, AUTOPLAY_START_MAX_MS, Q1_QUOTE_FRAGMENT, SCRIPT_TEXT } from '../src/server/demo/script.js'

const fake = (paypal as unknown as { __fake: FakePayPalState }).__fake

let db: Db
let T = Date.UTC(2026, 9, 16, 12, 0, 0)
const clock: DirectorClock = {
  now: () => T,
  sleep: async (ms) => {
    T += Math.max(0, Math.round(ms))
    await new Promise((r) => setImmediate(r))
  },
}
const events: { roomId: string; event: RoomEvent; audience: Audience }[] = []
let logs: string[] = []

const DETECT: DetectRule[] = [
  { question: 1, phrase: 'hold that thought', verdict: 'deflected', confidence: 0.92 },
  { question: 1, phrase: 'one router file per feature, shared code in a core package', verdict: 'answered', confidence: 0.95 },
  { question: 2, phrase: "Tests: mostly next to the code, but let's do testing properly next week", verdict: 'partial', confidence: 0.82 },
]

function claude(extra: Partial<RoutedClaudeOptions> = {}) {
  const client = routedClaude({
    intake: (text, open) => {
      if (/folders?/i.test(text) && open.includes(1) && text !== SCRIPT_TEXT.q1) return { allow: true, similar_to: 1, cues: ['folders'] }
      if (/folders?/i.test(text)) return { allow: true, cues: ['folders', 'router', 'package'] }
      return { allow: true, cues: ['tests', 'next to the code'] }
    },
    detect: DETECT,
    verify: () => ({ agree: true, reason: 'The quote gives a concrete folder layout.' }),
    ...extra,
  })
  setAnthropicClientForTests(client)
  return client
}

async function playDemo(opts: DirectorOptions = {}) {
  setDemoDirector((ctx) => runDirector(ctx, { clock, log: (m) => logs.push(m), ...opts }))
  const r = await startDemoRoom({ ip: '192.0.2.10', judgeCode: 'judge-code-for-tests' })
  const report = (await demoDirectorDone(r.roomId)) as DirectorReport
  expect(report).toBeTruthy()
  return { ...r, report }
}

const roomEvents = (roomId: string) => events.filter((e) => e.roomId === roomId).map((e) => e.event)

beforeAll(async () => {
  process.env.JUDGE_CODE = 'judge-code-for-tests'
  resetConfigForTests()
  setNowForTests(() => T)
  db = await openDb({ databaseUrl: null, pgliteDir: 'memory' })
  setDb(db)
  initDomain()
  onRoomEvent((roomId, event, audience) => events.push({ roomId, event, audience }))
})

afterAll(async () => {
  stopAllDetectors()
  setDemoDirector(null)
  setAnthropicClientForTests(undefined)
  setNowForTests(null)
  await db.close()
})

beforeEach(() => {
  fake.reset()
  events.length = 0
  logs = []
})

afterEach(() => {
  stopAllDetectors()
  setDemoDirector(null)
})

describe('demo replay director', () => {
  it('plays the video script: deflection, a $12 lock from 3 backers after the verifier, a partial in review', async () => {
    const client = claude()
    const { roomId, report } = await playDemo()

    expect(report.aborted).toBeNull()
    expect(report.mode).toBe('ai')
    expect(report.heldTabs).toBe(3)
    expect(report.declinedTabs).toBe(1)
    expect(report.firstStepAtMs).not.toBeNull()
    expect(report.firstStepAtMs!).toBeLessThanOrEqual(AUTOPLAY_START_MAX_MS)
    expect(report.finishedAtMs).toBeLessThanOrEqual(AUTOPLAY_BUDGET_MS)
    expect(report.steps.every((s) => s.ok)).toBe(true)

    // Ben's near-duplicate got the hint and reserved nothing; he backed Q1 instead.
    expect(report.steps.find((s) => s.id === 'ben-near-duplicate')!.note).toMatch(/similar to #1; nothing reserved/)
    const cons = await getConsoleView(roomId)
    expect(cons.room.questions.map((q) => q.number)).toEqual([1, 2])
    const tabs = Object.fromEntries(cons.tabs.map((t) => [t.displayName, t]))
    expect(tabs.Ben!.reservedCents).toBe(300)
    expect(tabs.Chen!.reservedCents).toBe(900)

    // Q1: deflected first (not charged, card stays open), then locked with the answer's quote.
    expect(report.cards.q1).toMatchObject({ number: 1, state: 'locked' })
    expect(report.cards.q1!.quote).toContain(Q1_QUOTE_FRAGMENT)
    const trail = report.trail.q1
    expect(trail.indexOf('deflected')).toBeGreaterThan(-1)
    expect(trail.indexOf('deflected')).toBeLessThan(trail.indexOf('locked'))
    expect(report.cards.q2).toMatchObject({ number: 2, state: 'review' })

    const verdicts = roomEvents(roomId).flatMap((e) => (e.type === 'verdict' && e.action !== 'ignore' ? [[e.questionNumber, e.action]] : []))
    expect(verdicts).toEqual([
      [1, 'deflected'],
      [1, 'verifying'],
      [1, 'lock'],
      [2, 'review'],
    ])
    // $12 with 3 backers: the Opus verifier ran before the lock.
    expect(client.requests.filter((r) => r.kind === 'verify')).toHaveLength(1)

    // Progress reaches the creator on existing events: replay segments, interim text, question and tab events.
    const ev = roomEvents(roomId)
    const segs = ev.flatMap((e) => (e.type === 'segment.added' ? [e.segment] : []))
    expect(segs.map((s) => [s.source, s.text])).toEqual([
      ['replay', SCRIPT_TEXT.deflection],
      ['replay', SCRIPT_TEXT.answer],
      ['replay', SCRIPT_TEXT.partial],
    ])
    expect(ev.filter((e) => e.type === 'segment.interim').length).toBe(5)
    expect(ev.filter((e) => e.type === 'question.created')).toHaveLength(2)
    expect(ev.filter((e) => e.type === 'backing.created')).toHaveLength(2)

    // Scripted offsets: ordered, and every backing landed before the answer started (nobody is a late backer).
    expect(segs[1]!.tStartMs - segs[0]!.tEndMs).toBeGreaterThanOrEqual(4_000)
    expect(segs[1]!.tStartMs - segs[0]!.tEndMs).toBeLessThanOrEqual(6_000)
    const backings = await db.query<{ backed_at_ms: number }>(`SELECT backed_at_ms FROM backings WHERE room_id = $1`, [roomId])
    expect(Math.max(...backings.map((b) => b.backed_at_ms))).toBeLessThanOrEqual(segs[1]!.tStartMs)

    // The room stays live for the judge's checklist.
    expect(cons.room.status).toBe('live')

    // End: Q1 holds $12 from 3 backers, Q2 waits for review.
    const review = await endRoom(roomId)
    expect(review.map((r) => [r.questionNumber, r.state])).toEqual([
      [1, 'locked'],
      [2, 'review'],
    ])
    expect(review[0]).toMatchObject({ backers: 3, lockedCents: 1200 })
    expect(review[0]!.quote).toContain(Q1_QUOTE_FRAGMENT)

    // Settle with Q2 rated half: one capture per held tab, the declined tab untouched.
    const s = await settleRoom(roomId, { '2': 'half' })
    expect(s.errors).toEqual([])
    const settled = Object.fromEntries(s.tabs.map((t) => [t.displayName, t]))
    expect(settled.Asha).toMatchObject({ state: 'captured', capturedCents: 600, releasedCents: 400 })
    expect(settled.Ben).toMatchObject({ state: 'captured', capturedCents: 300, releasedCents: 700 })
    expect(settled.Chen).toMatchObject({ state: 'captured', capturedCents: 600, releasedCents: 400 })
    expect(settled.Dev).toMatchObject({ state: 'declined', authStatus: 'DENIED', capturedCents: 0 })
    expect(fake.captures.size).toBe(3)
  })

  it('never charges for the deflection: with no answer Q1 stays deflected and settles unpaid', async () => {
    claude({ detect: DETECT.filter((r) => r.verdict !== 'answered') })
    const { roomId, report } = await playDemo()

    expect(report.aborted).toBeNull()
    expect(report.cards.q1).toMatchObject({ state: 'deflected' })
    const answer = report.steps.find((s) => s.id === 'answer-q1')!
    expect(answer).toMatchObject({ ok: false, state: 'deflected' })
    expect(answer.note).toMatch(/safety timeout/)
    expect(report.cards.q2?.state).toBe('review')
    expect(report.finishedAtMs).toBeLessThanOrEqual(AUTOPLAY_BUDGET_MS)

    const review = await endRoom(roomId)
    expect(review.find((r) => r.questionNumber === 1)).toMatchObject({ state: 'deflected', lockedCents: 0 })
    const s = await settleRoom(roomId, { '1': 'full', '2': 'half' })
    const tabs = Object.fromEntries(s.tabs.map((t) => [t.displayName, t]))
    // Asha and Ben only backed Q1: voided, nothing captured. Chen pays only the Q2 half.
    expect(tabs.Asha).toMatchObject({ state: 'voided', capturedCents: 0, releasedCents: 1000 })
    expect(tabs.Ben).toMatchObject({ state: 'voided', capturedCents: 0 })
    expect(tabs.Chen).toMatchObject({ state: 'captured', capturedCents: 300 })
    expect(tabs.Dev!.state).toBe('declined')
    const q1 = s.room.questions.find((q) => q.number === 1)!
    expect(q1.state).toBe('unpaid')
    expect(fake.calls.filter((c) => c.op === 'captureTab').map((c) => c.args.amountCents)).toEqual([300])
  })

  it('finishes in manual mode (no AI) and leaves the cards for the creator to point at', async () => {
    setAnthropicClientForTests(null)
    const { roomId, report } = await playDemo()

    expect(report.mode).toBe('manual')
    expect(report.aborted).toBeNull()
    expect(report.notes.some((n) => /manual-confirm mode/.test(n))).toBe(true)
    expect(logs.some((l) => /cards #1 and #2 wait for the creator/.test(l))).toBe(true)
    expect(report.cards.q1?.state).toBe('open')
    expect(report.cards.q2?.state).toBe('open')
    // The no-key intake fallback still spots Ben's near-duplicate.
    expect(report.steps.find((s) => s.id === 'ben-near-duplicate')!.note).toMatch(/similar to #1/)
    expect(report.steps.filter((s) => s.kind === 'say').map((s) => s.ok)).toEqual([false, false, false])

    // The creator confirms Q1 by pointing at the answer span; the same guard runs.
    const cons = await getConsoleView(roomId)
    const seg = cons.segments.find((x) => x.text === SCRIPT_TEXT.answer)!
    const q = await pointSpan(report.cards.q1!.id, { startSeg: seg.seq, startWord: 2, endSeg: seg.seq, endWord: seg.words.length - 1 })
    expect(q).toMatchObject({ state: 'locked', creatorConfirmed: true, quoteSource: 'replay' })
    expect(q.quote).toContain(Q1_QUOTE_FRAGMENT)
    const review = await endRoom(roomId)
    expect(review[0]).toMatchObject({ questionNumber: 1, backers: 3, lockedCents: 1200 })
  })

  it('survives the creator typing segments during the autoplay', async () => {
    claude()
    const { roomId, report } = await playDemo({
      beforeStep: async (step, at) => {
        // The creator types between replay lines; the typed segments are stamped on arrival.
        if (step.id === 'answer-q1') await addSegment(at.roomId, { text: 'Let me share my screen first.', final: true, source: 'typed', lagMs: 0 })
        if (step.id === 'partial-q2') await addSegment(at.roomId, { text: 'Folders, one router file per feature, got it.', final: true, source: 'typed', lagMs: 0 })
      },
    })
    expect(report.aborted).toBeNull()
    expect(report.cards.q1).toMatchObject({ state: 'locked' })
    expect(report.cards.q1!.quote).toContain(Q1_QUOTE_FRAGMENT)
    expect(report.cards.q2?.state).toBe('review')
    const segs = (await getConsoleView(roomId)).segments
    expect(segs.map((s) => s.source)).toEqual(['replay', 'typed', 'replay', 'typed', 'replay'])
    expect(segs.map((s) => s.seq)).toEqual([1, 2, 3, 4, 5])
  })

  it('stops quietly when the creator ends the stream mid-replay', async () => {
    claude()
    const { roomId, report } = await playDemo({
      beforeStep: async (step, at) => {
        if (step.id === 'partial-q2') await endRoom(at.roomId)
      },
    })
    expect(report.aborted).toBe('not_live')
    expect(report.cards.q1?.state).toBe('locked')
    expect(report.steps.at(-1)).toMatchObject({ id: 'partial-q2', ok: false })
    expect((await getConsoleView(roomId)).segments).toHaveLength(2)
  })

  it('runs no director under Vitest unless one is installed', async () => {
    claude()
    const r = await startDemoRoom({ ip: '192.0.2.11', judgeCode: 'judge-code-for-tests' })
    expect(await demoDirectorDone(r.roomId)).toBeNull()
    await demoTabsReady(r.roomId)
    expect(roomEvents(r.roomId).some((e) => e.type === 'question.created' || e.type === 'segment.added')).toBe(false)
  })
})
