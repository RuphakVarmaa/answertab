// Regression tests for the 2026-10-16 review (docs/review-2026-10-16.md), money paths: payout retries, verify
// after a refund, refused and stuck captures, pending captures, interrupted contest desks, expiry, payout polling,
// late locks after End, tab re-ordering, receipts before settlement and concurrent LLM spend.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'

vi.mock('../src/server/paypal/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/server/paypal/index.js')>()
  const { makeFakePayPal } = await import('../src/server/domain/testkit.js')
  const f = makeFakePayPal(actual) as any
  // Failure hooks the plain fake does not have: the write lands at "PayPal", then the response is lost or 5xx.
  const h = ((globalThis as any).__reviewHooks = { payoutFailures: 0, payoutStatus: 503, captureFailures: 0, polls: 0, pollFailAt: -1, pendingUntilPoll: 0 })
  return {
    ...actual,
    ...f,
    async createPayout(p: any) {
      const out = await f.createPayout(p)
      if (h.payoutFailures > 0) {
        h.payoutFailures--
        throw new actual.PayPalError({ name: h.payoutStatus === 0 ? 'TIMEOUT' : 'INTERNAL_SERVER_ERROR', message: 'response lost', httpStatus: h.payoutStatus })
      }
      return out
    },
    async captureTab(p: any) {
      if (h.captureFailures > 0) {
        h.captureFailures--
        throw new actual.PayPalError({ name: 'SERVICE_UNAVAILABLE', message: 'PayPal 503', httpStatus: 503 })
      }
      return f.captureTab(p)
    },
    async getPayoutBatch(id: string, ctx: any) {
      h.polls++
      if (h.polls === h.pollFailAt) throw new actual.PayPalError({ name: 'TIMEOUT', message: 'PayPal request timed out', httpStatus: 0 })
      const r = await f.getPayoutBatch(id, ctx)
      if (h.polls < h.pendingUntilPoll) return { ...r, batchStatus: 'PENDING', items: r.items.map((i: any) => ({ ...i, transactionStatus: 'PENDING' })) }
      return r
    },
  }
})

import * as paypal from '../src/server/paypal/index.js'
import { buildApp } from '../src/server/app.js'
import { resetConfigForTests } from '../src/server/config.js'
import { openDb, type Db } from '../src/server/db/db.js'
import { setAnthropicClientForTests } from '../src/server/ai/index.js'
import { fakeMessage } from '../src/server/ai/fakeClient.js'
import { contestsIdle, detectionIdle, openBotTab, recoverStaleContests, setNowForTests, stopAllDetectors } from '../src/server/domain/index.js'
import { classify, routedClaude, toolUse, type FakePayPalState, type RoutedClaudeOptions } from '../src/server/domain/testkit.js'
import { runDueJobs } from '../src/server/jobs/index.js'

const fake = (paypal as unknown as { __fake: FakePayPalState }).__fake
const hooks = (globalThis as any).__reviewHooks as { payoutFailures: number; payoutStatus: number; captureFailures: number; polls: number; pollFailAt: number; pendingUntilPoll: number }

let app: FastifyInstance
let db: Db
let T = Date.UTC(2026, 9, 16, 12, 0, 0)
const advance = (ms: number) => {
  T += ms
}

beforeAll(async () => {
  process.env.PAYPAL_CREATOR_PAYEE_EMAIL = 'creator-payee@example.com'
  resetConfigForTests()
  setNowForTests(() => T)
  db = await openDb({ databaseUrl: null, pgliteDir: 'memory' })
  app = buildApp({ db, rateLimit: false })
  await app.ready()
})

afterAll(async () => {
  stopAllDetectors()
  setAnthropicClientForTests(undefined)
  setNowForTests(null)
  await app.close()
  await db.close()
})

beforeEach(() => {
  fake.reset()
  Object.assign(hooks, { payoutFailures: 0, payoutStatus: 503, captureFailures: 0, polls: 0, pollFailAt: -1, pendingUntilPoll: 0 })
})

/** Runs every due job (other tests' rooms have jobs too, and one sweep claims at most 10). */
async function drain(): Promise<void> {
  for (let i = 0; i < 30 && (await runDueJobs()) > 0; i++) {
    // keep sweeping
  }
}

async function call(method: 'GET' | 'POST', url: string, o: { body?: unknown; creator?: string; fan?: string } = {}) {
  const res = await app.inject({
    method,
    url,
    ...(o.body !== undefined ? { payload: o.body as object } : {}),
    headers: { ...(o.creator ? { 'x-creator-token': o.creator } : {}), ...(o.fan ? { 'x-fan-token': o.fan } : {}) },
  })
  let body: any = null
  try {
    body = res.json()
  } catch {
    body = res.body
  }
  return { status: res.statusCode, body }
}

const Q1 = 'How should I split a big API project into folders?'
const Q2 = 'Should tests live next to the code?'
const ANSWER = 'Okay, folders: one router file per feature, shared code in a core package.'
const PARTIAL = "Tests: mostly next to the code, but let's do testing properly next week."

function claude(extra: Partial<RoutedClaudeOptions> = {}) {
  const c = routedClaude({
    intake: () => ({ allow: true, cues: ['folders', 'tests'] }),
    detect: [
      { question: 1, phrase: 'one router file per feature, shared code in a core package', verdict: 'answered', confidence: 0.95 },
      { question: 2, phrase: "Tests: mostly next to the code, but let's do testing properly next week", verdict: 'partial', confidence: 0.82 },
    ],
    verify: () => ({ agree: true, reason: 'ok' }),
    ...extra,
  })
  setAnthropicClientForTests(c)
  return c
}

async function join(roomId: string, name: string) {
  const r = await call('POST', `/api/rooms/${roomId}/fans`, { body: { displayName: name } })
  expect(r.status).toBe(201)
  return r.body as { fanId: string; fanToken: string }
}

async function cardTab(roomId: string, fanToken: string, ceilingCents = 1000) {
  const o = await call('POST', `/api/rooms/${roomId}/tab/order`, { fan: fanToken, body: { ceilingCents, funding: 'card' } })
  expect(o.status).toBe(200)
  fake.approve(o.body.orderId)
  const a = await call('POST', `/api/rooms/${roomId}/tab/authorize`, { fan: fanToken, body: { orderId: o.body.orderId } })
  expect(a.body.state).toBe('held')
  return a.body as { authorizationId: string; captureId: string | null }
}

async function say(roomId: string, ct: string, text: string) {
  const r = await call('POST', `/api/rooms/${roomId}/segments`, { creator: ct, body: { text, final: true, source: 'typed', lagMs: 0 } })
  expect(r.status).toBe(200)
  await detectionIdle(roomId)
}

/** A live room where every fan backs Q1 and the creator answers it (locked before End). */
async function answeredRoom(kind: 'demo' | 'public', names: string[], opts: { end?: boolean } = {}) {
  const r = await call('POST', '/api/rooms', { body: { kind, title: 'Office hours' } })
  const { roomId, creatorToken: ct } = r.body as { roomId: string; creatorToken: string }
  await call('POST', `/api/rooms/${roomId}/start`, { creator: ct })
  const fans: { fanId: string; fanToken: string }[] = []
  const tabs: { authorizationId: string }[] = []
  for (const n of names) {
    const f = await join(roomId, n)
    fans.push(f)
    tabs.push(await cardTab(roomId, f.fanToken))
  }
  advance(5_000)
  const q1 = await call('POST', `/api/rooms/${roomId}/questions`, { fan: fans[0]!.fanToken, body: { text: Q1 } })
  for (const f of fans.slice(1)) await call('POST', `/api/questions/${q1.body.id}/back`, { fan: f.fanToken })
  advance(10_000)
  await say(roomId, ct, ANSWER)
  if (opts.end !== false) await call('POST', `/api/rooms/${roomId}/end`, { creator: ct })
  return { roomId, ct, fans, tabs }
}

describe('payout after an unknown outcome (money F1)', () => {
  it('a 5xx after PayPal created the batch, then a second click, sends one batch', async () => {
    claude()
    const { roomId, ct } = await answeredRoom('demo', ['Asha'])
    expect((await call('POST', `/api/rooms/${roomId}/settle`, { creator: ct, body: {} })).body.room.status).toBe('settled')
    hooks.payoutFailures = 1
    hooks.payoutStatus = 503
    const first = await call('POST', `/api/rooms/${roomId}/close-contest-window`, { creator: ct })
    expect(first.status).toBe(502)
    const rows = await db.query<{ batch_status: string }>(`SELECT batch_status FROM payouts WHERE room_id = $1`, [roomId])
    expect(rows.map((r) => r.batch_status)).toEqual(['CREATING'])
    const second = await call('POST', `/api/rooms/${roomId}/close-contest-window`, { creator: ct })
    expect(second.status).toBe(200)
    expect(second.body.payout.payoutBatchId).toBeTruthy()
    expect([...fake.payouts.values()].map((b) => b.senderBatchId)).toEqual([`payout-${roomId}-1`])
  })

  it('two lost responses, then the job retries with the same sender_batch_id', async () => {
    claude()
    const { roomId, ct } = await answeredRoom('public', ['Asha'])
    await call('POST', `/api/rooms/${roomId}/settle`, { creator: ct, body: {} })
    hooks.payoutFailures = 2
    hooks.payoutStatus = 0
    advance(25 * 3600_000)
    await drain()
    advance(10 * 60_000)
    await drain()
    const rows = await db.query<{ attempt: number; payout_batch_id: string | null }>(`SELECT attempt, payout_batch_id FROM payouts WHERE room_id = $1`, [roomId])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.payout_batch_id).toBeTruthy()
    expect([...fake.payouts.values()]).toHaveLength(1)
  })

  it('a definitive 4xx still fails the attempt, and the next one gets a new id', async () => {
    claude()
    const { roomId, ct } = await answeredRoom('demo', ['Asha'])
    await call('POST', `/api/rooms/${roomId}/settle`, { creator: ct, body: {} })
    hooks.payoutFailures = 1
    hooks.payoutStatus = 422
    expect((await call('POST', `/api/rooms/${roomId}/close-contest-window`, { creator: ct })).status).toBe(502)
    const again = await call('POST', `/api/rooms/${roomId}/close-contest-window`, { creator: ct })
    expect(again.status).toBe(200)
    const rows = await db.query<{ attempt: number; batch_status: string }>(`SELECT attempt, batch_status FROM payouts WHERE room_id = $1 ORDER BY attempt`, [roomId])
    expect(rows.map((r) => [r.attempt, r.batch_status === 'FAILED'])).toEqual([[1, true], [2, false]])
  })
})

describe('verify with PayPal after a contest refund (money F2 / judge F1)', () => {
  it('keeps the tab captured and keeps its capture net in the payout', async () => {
    claude({
      contest: [
        { content: [toolUse('t1', 'refund_contested_share', { finding: 'deferred', evidence: 'next week', explanation: 'Deferred, refunded.' })], stop: 'tool_use' },
        { text: 'Done.' },
      ],
    })
    const r = await call('POST', '/api/rooms', { body: { kind: 'demo', title: 'Office hours' } })
    const { roomId, creatorToken: ct } = r.body
    await call('POST', `/api/rooms/${roomId}/start`, { creator: ct })
    const asha = await join(roomId, 'Asha')
    const chen = await join(roomId, 'Chen')
    await cardTab(roomId, asha.fanToken)
    await cardTab(roomId, chen.fanToken)
    advance(5_000)
    const q1 = await call('POST', `/api/rooms/${roomId}/questions`, { fan: asha.fanToken, body: { text: Q1 } })
    await call('POST', `/api/questions/${q1.body.id}/back`, { fan: chen.fanToken })
    await call('POST', `/api/rooms/${roomId}/questions`, { fan: chen.fanToken, body: { text: Q2 } })
    advance(10_000)
    await say(roomId, ct, ANSWER)
    advance(10_000)
    await say(roomId, ct, PARTIAL)
    await call('POST', `/api/rooms/${roomId}/end`, { creator: ct })
    expect((await call('POST', `/api/rooms/${roomId}/settle`, { creator: ct, body: { ratings: { '2': 'half' } } })).body.room.status).toBe('settled')

    const me = (await call('GET', `/api/rooms/${roomId}/me`, { fan: chen.fanToken })).body
    const token = me.tab.receiptToken as string
    const receipt = (await call('GET', `/api/receipts/${token}`)).body
    const q2Line = (receipt.lines as any[]).find((l) => l.questionNumber === 2)
    expect((await call('POST', `/api/receipts/${token}/contest`, { body: { backingId: q2Line.backingId, reason: 'Testing was never answered.' } })).status).toBe(201)
    await contestsIdle()
    // Real PayPal reads a partly refunded capture back as PARTIALLY_REFUNDED (sandbox proof L8y5vV).
    fake.captures.get(me.tab.captureId)!.status = 'PARTIALLY_REFUNDED'
    advance(11_000)
    expect((await call('POST', `/api/receipts/${token}/verify`)).status).toBe(200)
    const after = (await call('GET', `/api/receipts/${token}`)).body
    expect(after.tab.state).toBe('captured')
    const close = await call('POST', `/api/rooms/${roomId}/close-contest-window`, { creator: ct })
    // nets 554 + 554 = 1108, minus the 300 refund, minus 5% of 1200 = 60 -> 748
    expect(close.body.payout.amountCents).toBe(748)
  })
})

describe('settlement retries and refusals (money F5, F7 / judge F17)', () => {
  it('a settle left with unknown outcomes is finished by the settle_retry job', async () => {
    claude()
    const { roomId, ct } = await answeredRoom('demo', ['Asha'])
    hooks.captureFailures = 2
    const s = await call('POST', `/api/rooms/${roomId}/settle`, { creator: ct, body: {} })
    expect(s.body.room.status).toBe('settling')
    expect(s.body.errors).toHaveLength(1)
    const [job] = await db.query<{ state: string }>(`SELECT state FROM jobs WHERE kind = 'settle_retry' AND room_id = $1`, [roomId])
    expect(job?.state).toBe('pending')
    advance(61_000)
    await drain()
    const v = (await call('GET', `/api/rooms/${roomId}/console`, { creator: ct })).body
    expect(v.room.status).toBe('settled')
    expect(v.tabs[0].state).toBe('captured')
    expect(fake.captures.size).toBe(1)
  })

  it('a refused capture voids the hold instead of leaving it open', async () => {
    claude()
    const { roomId, ct, tabs } = await answeredRoom('demo', ['Asha'])
    fake.failNext.set('captureTab', { status: 422, name: 'UNPROCESSABLE_ENTITY', issue: 'INSTRUMENT_DECLINED' })
    const s = await call('POST', `/api/rooms/${roomId}/settle`, { creator: ct, body: {} })
    expect(s.body.room.status).toBe('voided')
    expect(s.body.tabs[0]).toMatchObject({ state: 'failed', authStatus: 'VOIDED', releasedCents: 1000, capturedCents: 0 })
    expect(fake.auths.get(tabs[0]!.authorizationId)!.status).toBe('VOIDED')
    expect(fake.calls.find((c) => c.op === 'voidTab')!.requestId).toMatch(/-a1$/)
  })
})

describe('captures still pending at payout time (money F13)', () => {
  it('holds the payout until every capture completes, then pays all of them', async () => {
    claude()
    const { roomId, ct } = await answeredRoom('demo', ['Asha', 'Ben'])
    fake.captureStatus = 'PENDING'
    await call('POST', `/api/rooms/${roomId}/settle`, { creator: ct, body: {} })
    const caps = [...fake.captures.values()]
    caps[1]!.status = 'COMPLETED'
    const early = await call('POST', `/api/rooms/${roomId}/close-contest-window`, { creator: ct })
    expect(early.status).toBe(409)
    expect(early.body.error.code).toBe('captures_pending')
    expect(fake.payouts.size).toBe(0)
    caps[0]!.status = 'COMPLETED'
    const close = await call('POST', `/api/rooms/${roomId}/close-contest-window`, { creator: ct })
    expect(close.status).toBe(200)
    // nets 554 + 262 = 816, minus 5% of 900 = 45 -> 771
    expect(close.body.payout.amountCents).toBe(771)
  })
})

describe('contest desk interrupted (money F6 / judge F18)', () => {
  it('a lost desk run becomes decidable, and the payout follows', async () => {
    const base = claude()
    let unhang!: (e: Error) => void
    const hung = new Promise<never>((_, reject) => (unhang = reject))
    setAnthropicClientForTests({
      async create(params, o) {
        if (classify(params) === 'contest') return hung // hangs, like a run lost in a restart
        return base.create(params, o)
      },
    })
    const { roomId, ct, fans } = await answeredRoom('demo', ['Asha'])
    await call('POST', `/api/rooms/${roomId}/settle`, { creator: ct, body: {} })
    const token = (await call('GET', `/api/rooms/${roomId}/me`, { fan: fans[0]!.fanToken })).body.tab.receiptToken
    const line = (await call('GET', `/api/receipts/${token}`)).body.lines[0]
    const c = await call('POST', `/api/receipts/${token}/contest`, { body: { backingId: line.backingId, reason: 'Not answered.' } })
    expect(c.status).toBe(201)
    await new Promise((r) => setTimeout(r, 50))
    // While the desk is working, the creator cannot decide over it.
    expect((await call('POST', `/api/contests/${c.body.id}/decide`, { creator: ct, body: { approve: false } })).status).toBe(409)
    advance(11 * 60_000)
    const decide = await call('POST', `/api/contests/${c.body.id}/decide`, { creator: ct, body: { approve: false } })
    expect(decide.status).toBe(200)
    expect(decide.body.state).toBe('upheld')
    const close = await call('POST', `/api/rooms/${roomId}/close-contest-window`, { creator: ct })
    expect(close.status).toBe(200)
    expect(close.body.payout.amountCents).toBeGreaterThan(0)
    // The lost desk finally fails: it must not overwrite the creator's decision.
    unhang(new Error('connection reset'))
    await contestsIdle()
    expect((await call('GET', `/api/receipts/${token}`)).body.lines[0].contest.state).toBe('upheld')
  })

  it('at boot, contests left open or deciding go to the creator', async () => {
    claude()
    const { roomId, ct, fans } = await answeredRoom('demo', ['Asha'])
    await call('POST', `/api/rooms/${roomId}/settle`, { creator: ct, body: {} })
    const [b] = await db.query<{ id: string; tab_id: string }>(`SELECT id, tab_id FROM backings WHERE room_id = $1`, [roomId])
    // A contest row a previous process left behind (no desk runs for it here).
    await db.query(`INSERT INTO contests (id, room_id, tab_id, backing_id, reason, state) VALUES ('ct_left', $1, $2, $3, 'x', 'deciding')`, [roomId, b!.tab_id, b!.id])
    expect(await recoverStaleContests()).toBeGreaterThanOrEqual(1)
    const [row] = await db.query<{ state: string; refund_cents: number }>(`SELECT state, refund_cents FROM contests WHERE id = 'ct_left'`)
    expect(row).toMatchObject({ state: 'failed', refund_cents: 600 })
    expect(fans).toHaveLength(1)
  })
})

describe('room expiry and abandoned rooms (money F3, F8 / judge F8)', () => {
  it('a room nobody ends is ended, its holds voided, before anything is deleted', async () => {
    claude()
    const r = await call('POST', '/api/rooms', { body: { kind: 'demo', title: 'Office hours' } })
    const { roomId, creatorToken: ct } = r.body
    await call('POST', `/api/rooms/${roomId}/start`, { creator: ct })
    const asha = await join(roomId, 'Asha')
    const tab = await cardTab(roomId, asha.fanToken)
    advance(61 * 60_000) // demo rooms end themselves after 1 h live
    await drain()
    expect((await call('GET', `/api/rooms/${roomId}`)).body.status).toBe('ended')
    advance(31 * 60_000) // the approve deadline voids every hold
    await drain()
    expect(fake.auths.get(tab.authorizationId)!.status).toBe('VOIDED')
    expect((await call('GET', `/api/rooms/${roomId}`)).body.status).toBe('voided')
  })

  it('expiry voids a still-held tab first (room never started)', async () => {
    claude()
    const r = await call('POST', '/api/rooms', { body: { kind: 'public', title: 'Office hours' } })
    const { roomId } = r.body
    const asha = await join(roomId, 'Asha')
    const tab = await cardTab(roomId, asha.fanToken, 2000) // holds can be placed while the room is a draft
    advance(7 * 24 * 3600_000 + 60_000)
    await drain()
    expect(fake.auths.get(tab.authorizationId)!.status).toBe('VOIDED')
    expect(await db.query(`SELECT 1 FROM tabs WHERE room_id = $1`, [roomId])).toHaveLength(0)
  })

  it('a room created days before its stream still pays the creator', async () => {
    claude()
    const r = await call('POST', '/api/rooms', { body: { kind: 'public', title: 'Sunday office hours' } })
    const { roomId, creatorToken: ct } = r.body
    advance(6 * 24 * 3600_000)
    await call('POST', `/api/rooms/${roomId}/start`, { creator: ct })
    const asha = await join(roomId, 'Asha')
    await cardTab(roomId, asha.fanToken)
    advance(5_000)
    await call('POST', `/api/rooms/${roomId}/questions`, { fan: asha.fanToken, body: { text: Q1 } })
    advance(10_000)
    await say(roomId, ct, ANSWER)
    advance(3 * 3600_000)
    await call('POST', `/api/rooms/${roomId}/end`, { creator: ct })
    expect((await call('POST', `/api/rooms/${roomId}/settle`, { creator: ct, body: {} })).body.room.status).toBe('settled')
    advance(25 * 3600_000) // past the contest window and past day 7 since creation
    await drain()
    await drain()
    expect(await db.query(`SELECT 1 FROM payouts WHERE room_id = $1`, [roomId])).toHaveLength(1)
    expect(await db.query(`SELECT 1 FROM tabs WHERE room_id = $1`, [roomId])).toHaveLength(1)
    const [job] = await db.query<{ run_at: Date }>(`SELECT run_at FROM jobs WHERE kind = 'expire_room' AND room_id = $1`, [roomId])
    expect(new Date(job!.run_at).getTime()).toBeGreaterThan(T + 6 * 24 * 3600_000)
  })
})

describe('payout polling (money F12 / judge F26)', () => {
  it('survives a transient error after the 5th poll and backs off after 15 minutes', async () => {
    claude()
    const { roomId, ct } = await answeredRoom('demo', ['Asha'])
    await call('POST', `/api/rooms/${roomId}/settle`, { creator: ct, body: {} })
    hooks.pollFailAt = 6
    hooks.pendingUntilPoll = 100 // PENDING past the fast-poll phase
    await call('POST', `/api/rooms/${roomId}/close-contest-window`, { creator: ct })
    const pollJob = async () =>
      (await db.query<{ state: string; run_at: Date; payload: { polls: number } }>(`SELECT state, run_at, payload FROM jobs WHERE kind = 'poll_payout' AND room_id = $1`, [roomId]))[0]
    for (let i = 0; i < 200 && Number((await pollJob())?.payload.polls ?? 0) < 90; i++) {
      advance(31_000)
      await drain()
    }
    const job = await pollJob()
    expect(job!.state).toBe('pending')
    expect(job!.payload.polls).toBeGreaterThanOrEqual(90)
    expect(new Date(job!.run_at).getTime() - T).toBeGreaterThan(5 * 60_000) // slow phase
    for (let i = 0; i < 10; i++) {
      advance(10 * 60_000)
      await drain()
    }
    expect((await call('GET', `/api/rooms/${roomId}/console`, { creator: ct })).body.payout.state).toBe('success')
  })
})

describe('End while a card is verifying (judge F2, server part)', () => {
  it('a verifier result after End sends the card to review, and settle does not charge it by default', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const inner = claude()
    setAnthropicClientForTests({
      async create(params, o) {
        if (classify(params) === 'verify') await gate
        return inner.create(params, o)
      },
    })
    const r = await call('POST', '/api/rooms', { body: { kind: 'demo', title: 'Office hours' } })
    const { roomId, creatorToken: ct } = r.body
    await call('POST', `/api/rooms/${roomId}/start`, { creator: ct })
    const fans = []
    for (const name of ['Asha', 'Ben', 'Chen']) {
      const f = await join(roomId, name)
      await openBotTab(roomId, f.fanId, { ceilingCents: 1000, card: paypal.botCard(0, name) })
      fans.push(f)
    }
    advance(5_000)
    const q = (await call('POST', `/api/rooms/${roomId}/questions`, { fan: fans[0]!.fanToken, body: { text: Q1 } })).body
    for (const f of fans.slice(1)) await call('POST', `/api/questions/${q.id}/back`, { fan: f.fanToken })
    advance(10_000)
    await call('POST', `/api/rooms/${roomId}/segments`, { creator: ct, body: { text: ANSWER, final: true, source: 'typed', lagMs: 0 } })
    for (let i = 0; i < 100 && (await call('GET', `/api/rooms/${roomId}`)).body.questions[0].state !== 'verifying'; i++) await new Promise((x) => setTimeout(x, 10))
    await call('POST', `/api/rooms/${roomId}/end`, { creator: ct })
    const blocked = await call('POST', `/api/rooms/${roomId}/settle`, { creator: ct, body: {} })
    expect(blocked.status).toBe(409)
    expect(blocked.body.error.code).toBe('still_verifying')
    release()
    await detectionIdle(roomId)
    expect((await call('GET', `/api/rooms/${roomId}`)).body.questions[0].state).toBe('review')
    const s = await call('POST', `/api/rooms/${roomId}/settle`, { creator: ct, body: {} })
    expect(s.body.tabs.reduce((a: number, t: any) => a + t.capturedCents, 0)).toBe(0)
    expect(s.body.room.status).toBe('voided')
  })

  it('a card locked when End was clicked is charged by default; one locked later only with a rating', async () => {
    claude()
    const { roomId, ct, fans } = await answeredRoom('demo', ['Asha', 'Ben'], { end: false })
    expect((await call('POST', `/api/rooms/${roomId}/questions`, { fan: fans[1]!.fanToken, body: { text: Q2 } })).status).toBe(201)
    await call('POST', `/api/rooms/${roomId}/end`, { creator: ct })
    // A lock that lands after End (simulated) is not part of "Approve all".
    await db.query(`UPDATE questions SET state = 'locked', answer_start_ms = 0 WHERE room_id = $1 AND number = 2`, [roomId])
    const review = (await call('GET', `/api/rooms/${roomId}/review`, { creator: ct })).body as any[]
    expect(review.map((i) => [i.questionNumber, i.state, i.chargedByDefault])).toEqual([[1, 'locked', true], [2, 'locked', false]])
    const s = await call('POST', `/api/rooms/${roomId}/settle`, { creator: ct, body: {} })
    const qs = (await call('GET', `/api/rooms/${roomId}`)).body.questions as any[]
    expect(qs.map((x) => [x.number, x.state])).toEqual([[1, 'approved'], [2, 'unpaid']])
    expect(s.body.tabs.map((t: any) => t.capturedCents)).toEqual([600, 300])
  })
})

describe('receipts before settlement (judge F6, server part)', () => {
  it('chargeCents is null with status reserved until the tab settles', async () => {
    claude()
    const { roomId, ct, fans } = await answeredRoom('demo', ['Asha'], { end: false })
    const token = (await call('GET', `/api/rooms/${roomId}/me`, { fan: fans[0]!.fanToken })).body.tab.receiptToken
    const live = (await call('GET', `/api/receipts/${token}`)).body
    expect(live.lines[0]).toMatchObject({ chargeCents: null, status: 'reserved' })
    await call('POST', `/api/rooms/${roomId}/end`, { creator: ct })
    await call('POST', `/api/rooms/${roomId}/settle`, { creator: ct, body: {} })
    const done = (await call('GET', `/api/receipts/${token}`)).body
    expect(done.lines[0]).toMatchObject({ chargeCents: 600, status: 'charged' })
  })
})

describe('re-ordering a tab before the hold exists (judge F7)', () => {
  it('a new size or payment method creates a new order with the next request-id suffix', async () => {
    claude()
    const r = await call('POST', '/api/rooms', { body: { kind: 'demo', title: 'Office hours' } })
    const { roomId, creatorToken: ct } = r.body
    await call('POST', `/api/rooms/${roomId}/start`, { creator: ct })
    const asha = await join(roomId, 'Asha')
    const o1 = await call('POST', `/api/rooms/${roomId}/tab/order`, { fan: asha.fanToken, body: { ceilingCents: 1000, funding: 'card' } })
    const same = await call('POST', `/api/rooms/${roomId}/tab/order`, { fan: asha.fanToken, body: { ceilingCents: 1000, funding: 'card' } })
    expect(same.body.orderId).toBe(o1.body.orderId)
    const o2 = await call('POST', `/api/rooms/${roomId}/tab/order`, { fan: asha.fanToken, body: { ceilingCents: 2000, funding: 'paypal' } })
    expect(o2.status).toBe(200)
    expect(o2.body.orderId).not.toBe(o1.body.orderId)
    expect(o2.body.tab).toMatchObject({ ceilingCents: 2000, funding: 'paypal', state: 'opening' })
    const ids = fake.calls.filter((c) => c.op === 'createAuthorizeOrder').map((c) => c.requestId)
    expect(ids).toEqual([expect.stringMatching(/^order-.*[^1]$/), expect.stringMatching(/-a1$/)])
    // The old order no longer belongs to the tab; the new one places the hold.
    fake.approve(o1.body.orderId)
    expect((await call('POST', `/api/rooms/${roomId}/tab/authorize`, { fan: asha.fanToken, body: { orderId: o1.body.orderId } })).status).toBe(400)
    fake.approve(o2.body.orderId)
    const held = await call('POST', `/api/rooms/${roomId}/tab/authorize`, { fan: asha.fanToken, body: { orderId: o2.body.orderId } })
    expect(held.body).toMatchObject({ state: 'held', ceilingCents: 2000 })
    expect((await call('POST', `/api/rooms/${roomId}/tab/order`, { fan: asha.fanToken, body: { ceilingCents: 1000, funding: 'card' } })).body.error.code).toBe('tab_exists')
  })
})

describe('concurrent contest desks and the room LLM cap (money F9)', () => {
  it('stays near ROOM_CAP_MICROS', async () => {
    const base = claude()
    let n = 0
    setAnthropicClientForTests({
      async create(params, o) {
        if (classify(params) !== 'contest') return base.create(params, o)
        n++
        await new Promise((r) => setTimeout(r, 20))
        const last = params.messages[params.messages.length - 1] as any
        const hasResults = Array.isArray(last?.content) && last.content.some((b: any) => b.type === 'tool_result')
        const usage = { input_tokens: 3000, output_tokens: 10_000 } // about $0.21 of Opus per turn
        return hasResults
          ? fakeMessage({ content: [toolUse(`u${n}`, 'uphold_charge', { evidence: 'answered', explanation: 'Answered.' })], stop: 'tool_use', usage }, params.model)
          : fakeMessage({ content: [toolUse(`r${n}`, 'get_card_record')], stop: 'tool_use', usage }, params.model)
      },
    })
    const names = Array.from({ length: 8 }, (_, i) => `Fan${i}`)
    const { roomId, ct, fans } = await answeredRoom('public', names)
    await call('POST', `/api/rooms/${roomId}/settle`, { creator: ct, body: {} })
    const tokens: string[] = []
    for (const f of fans) tokens.push((await call('GET', `/api/rooms/${roomId}/me`, { fan: f.fanToken })).body.tab.receiptToken)
    const lines = await Promise.all(tokens.map(async (t) => (await call('GET', `/api/receipts/${t}`)).body.lines[0].backingId))
    await Promise.all(tokens.map((t, i) => call('POST', `/api/receipts/${t}/contest`, { body: { backingId: lines[i], reason: 'I was not answered.' } })))
    await contestsIdle()
    const [room] = await db.query<{ llm_spent_micros: string }>(`SELECT llm_spent_micros FROM rooms WHERE id = $1`, [roomId])
    expect(Number(room!.llm_spent_micros)).toBeLessThanOrEqual(750_000)
  })
})
