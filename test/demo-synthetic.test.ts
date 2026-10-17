// The synthetic run end to end on fakes: fixture-shaped PayPal, routed Claude (including the contest desk),
// in-memory PGlite. Checks that it passes, records synthetic_runs, and keeps tokens out of the stored details.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../src/server/paypal/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/server/paypal/index.js')>()
  const { makeFakePayPal } = await import('../src/server/domain/testkit.js')
  return { ...actual, ...makeFakePayPal(actual) }
})

import * as paypal from '../src/server/paypal/index.js'
import { resetConfigForTests } from '../src/server/config.js'
import { openDb, setDb, type Db } from '../src/server/db/db.js'
import { setAnthropicClientForTests } from '../src/server/ai/index.js'
import { initDomain, setNowForTests, stopAllDetectors } from '../src/server/domain/index.js'
import { routedClaude, toolUse, type FakePayPalState } from '../src/server/domain/testkit.js'
import type { DirectorClock } from '../src/server/demo/director.js'
import { runSynthetic, startSyntheticScheduler } from '../src/server/demo/synthetic.js'
import { SCRIPT_TEXT } from '../src/server/demo/script.js'

const fake = (paypal as unknown as { __fake: FakePayPalState }).__fake

let db: Db
let T = Date.UTC(2026, 10, 5, 9, 0, 0)
const clock: DirectorClock = {
  now: () => T,
  sleep: async (ms) => {
    T += Math.max(0, Math.round(ms))
    await new Promise((r) => setImmediate(r))
  },
}

beforeAll(async () => {
  process.env.JUDGE_CODE = 'judge-code-for-tests'
  process.env.PAYPAL_CREATOR_PAYEE_EMAIL = 'creator-payee@example.com'
  resetConfigForTests()
  setNowForTests(() => T)
  db = await openDb({ databaseUrl: null, pgliteDir: 'memory' })
  setDb(db)
  initDomain()
})

afterAll(async () => {
  stopAllDetectors()
  setAnthropicClientForTests(undefined)
  setNowForTests(null)
  await db.close()
})

function claude(contestFinding: 'deferred' | 'partially_answered') {
  setAnthropicClientForTests(
    routedClaude({
      intake: (text, open) => {
        if (/folders?/i.test(text) && open.includes(1) && text !== SCRIPT_TEXT.q1) return { allow: true, similar_to: 1, cues: ['folders'] }
        if (/folders?/i.test(text)) return { allow: true, cues: ['folders', 'router', 'package'] }
        return { allow: true, cues: ['tests', 'next to the code'] }
      },
      detect: [
        { question: 1, phrase: 'hold that thought', verdict: 'deflected', confidence: 0.92 },
        { question: 1, phrase: 'one router file per feature, shared code in a core package', verdict: 'answered', confidence: 0.95 },
        { question: 2, phrase: "Tests: mostly next to the code, but let's do testing properly next week", verdict: 'partial', confidence: 0.82 },
      ],
      verify: () => ({ agree: true, reason: 'Concrete folder layout.' }),
      contest: [
        { content: [toolUse('t1', 'get_card_record'), toolUse('t2', 'get_order')], stop: 'tool_use' },
        {
          content: [toolUse('t3', 'refund_contested_share', { finding: contestFinding, evidence: "let's do testing properly next week", explanation: 'The testing setup was put off to next week.' })],
          stop: 'tool_use',
        },
        { text: 'Done.' },
      ],
    }),
  )
}

describe('synthetic run', () => {
  it('runs the whole judge path, records synthetic_runs, and stores no tokens', async () => {
    fake.reset()
    claude('deferred')
    const r = await runSynthetic({ directorClock: clock, sleep: clock.sleep, pollEveryMs: 1_000, log: () => {} })
    expect(r.details.checks.filter((c) => !c.ok)).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.details.mode).toBe('ai')
    expect(r.details.pool).toBe('judge')
    const tabs = Object.fromEntries(r.details.paypal.tabs.map((t) => [t.fan, t]))
    expect(tabs.Asha).toMatchObject({ state: 'captured', capturedCents: 600 })
    expect(tabs.Ben).toMatchObject({ state: 'captured', capturedCents: 300 })
    expect(tabs.Chen).toMatchObject({ state: 'captured', capturedCents: 600 })
    expect(tabs.Dev).toMatchObject({ state: 'declined', authStatus: 'DENIED' })
    expect(tabs.Eve).toMatchObject({ state: 'voided', capturedCents: 0 })
    expect(r.details.paypal.refund).toMatchObject({ state: 'refunded', finding: 'deferred', refundCents: 300 })
    expect(r.details.paypal.refund!.refundId).toMatch(/^RF/)
    expect(r.details.paypal.payout).toMatchObject({ state: 'success', batchStatus: 'SUCCESS' })
    expect(r.details.costs.byPurpose.verify?.calls).toBe(1)
    expect(fake.calls.filter((c) => c.op === 'voidTab')).toHaveLength(1)
    // Replay-to-state timing for each 'say' step (room clock), and the Q1 replay-to-lock for the soak table.
    const says = r.details.director!.steps.filter((s) => ['deflection', 'answer-q1', 'partial-q2'].includes(s.id))
    expect(says).toHaveLength(3)
    for (const s of says) {
      expect(s.reachedAtMs).toBeGreaterThanOrEqual(s.atMs)
      expect(s.replayToStateMs).toBe(s.reachedAtMs! - s.atMs)
    }
    expect(says.find((s) => s.id === 'answer-q1')!.state).toBe('locked')
    expect(r.details.director!.replayToLockMs).toBe(says.find((s) => s.id === 'answer-q1')!.replayToStateMs)
    expect(r.details.director!.steps.find((s) => s.id === 'asha-asks-q1')).not.toHaveProperty('reachedAtMs')

    const [row] = await db.query<{ ok: boolean; room_id: string; finished_at: Date | null; details: unknown }>(`SELECT * FROM synthetic_runs WHERE id = $1`, [r.id])
    expect(row).toMatchObject({ ok: true, room_id: r.roomId })
    expect(row!.finished_at).not.toBeNull()
    // No creator, fan or receipt tokens in what is stored.
    const stored = JSON.stringify(row!.details)
    const tokens = await db.query<{ t: string }>(
      `SELECT fan_token AS t FROM fans WHERE room_id = $1 UNION ALL SELECT receipt_token FROM tabs WHERE room_id = $1 AND receipt_token IS NOT NULL`,
      [r.roomId],
    )
    expect(tokens.length).toBeGreaterThan(4)
    for (const { t } of tokens) expect(stored).not.toContain(t)
  })

  it('approves as the creator when the desk asks for approval, and fails loudly when PayPal refuses', async () => {
    fake.reset()
    claude('partially_answered')
    const r = await runSynthetic({ directorClock: clock, sleep: clock.sleep, pollEveryMs: 1_000, log: () => {} })
    expect(r.ok).toBe(true)
    expect(r.details.checks.find((c) => c.name === 'contest_refund')!.detail).toMatch(/desk pending_creator -> refunded/)

    fake.reset()
    claude('deferred')
    fake.failNext.set('captureTab', { status: 422, name: 'UNPROCESSABLE_ENTITY', issue: 'AUTHORIZATION_VOIDED' })
    const bad = await runSynthetic({ directorClock: clock, sleep: clock.sleep, pollEveryMs: 1_000, log: () => {} })
    expect(bad.ok).toBe(false)
    expect(bad.details.checks.find((c) => c.name === 'settle')!.ok).toBe(false)
    const [row] = await db.query<{ ok: boolean }>(`SELECT ok FROM synthetic_runs WHERE id = $1`, [bad.id])
    expect(row!.ok).toBe(false)
  })

  it('schedules nothing unless SYNTHETIC_EVERY_MIN is set', () => {
    delete process.env.SYNTHETIC_EVERY_MIN
    const logs: string[] = []
    const stop = startSyntheticScheduler({ log: (m) => logs.push(m) })
    expect(logs).toEqual([])
    stop()
    const stop2 = startSyntheticScheduler({ everyMin: 1, firstDelayMs: 3_600_000, log: (m) => logs.push(m) })
    expect(logs).toEqual(['scheduled every 5 min'])
    stop2()
  })
})
