// End-to-end against the real PayPal sandbox (scripted Claude, in-memory PGlite). Runs only with ANSWERTAB_E2E=1
// and reads .env itself:   ANSWERTAB_E2E=1 npx vitest run test/e2e.sandbox.test.ts
// Real: bot_card holds (one processor decline), final captures, a void, the replayed capture, live receipt
// verification, a contest refund through the Agent Toolkit, and a Payouts batch to the demo creator account.
import { existsSync, writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/server/app.js'
import { resetConfigForTests } from '../src/server/config.js'
import { openDb, type Db } from '../src/server/db/db.js'
import { setAnthropicClientForTests } from '../src/server/ai/index.js'
import { contestsIdle, detectionIdle, openBotTab, setNowForTests, stopAllDetectors } from '../src/server/domain/index.js'
import { routedClaude, toolUse } from '../src/server/domain/testkit.js'
import { demoTabsReady } from '../src/server/demo/index.js'
import { runDueJobs } from '../src/server/jobs/index.js'
import { botCard } from '../src/server/paypal/index.js'

const RUN = process.env.ANSWERTAB_E2E === '1'
const T = 300_000

describe.skipIf(!RUN)('AnswerTab end-to-end on the PayPal sandbox', () => {
  let app: FastifyInstance
  let db: Db
  let now = Date.now()
  const ids: Record<string, unknown> = {}

  const call = async (method: 'GET' | 'POST', url: string, o: { body?: unknown; creator?: string; fan?: string } = {}) => {
    const res = await app.inject({
      method,
      url,
      ...(o.body !== undefined ? { payload: o.body as object } : {}),
      headers: { ...(o.creator ? { 'x-creator-token': o.creator } : {}), ...(o.fan ? { 'x-fan-token': o.fan } : {}) },
    })
    return { status: res.statusCode, body: res.json() as any }
  }

  beforeAll(async () => {
    if (existsSync('.env')) process.loadEnvFile('.env')
    resetConfigForTests()
    setNowForTests(() => now)
    setAnthropicClientForTests(
      routedClaude({
        intake: (text) => ({ allow: true, cues: /folder/i.test(text) ? ['folders', 'router'] : ['tests', 'next to the code'] }),
        detect: [
          { question: 1, phrase: 'hold that thought', verdict: 'deflected', confidence: 0.9 },
          { question: 1, phrase: 'one router file per feature, shared code in a core package', verdict: 'answered', confidence: 0.95 },
          { question: 2, phrase: "Tests: mostly next to the code, but let's do testing properly next week", verdict: 'partial', confidence: 0.8 },
        ],
        verify: () => ({ agree: true, reason: 'Concrete folder layout given.' }),
        contest: [
          { content: [toolUse('t1', 'get_card_record'), toolUse('t2', 'get_order')], stop: 'tool_use' },
          { content: [toolUse('t3', 'refund_contested_share', { finding: 'deferred', evidence: "let's do testing properly next week", explanation: 'The testing setup was put off to next week, so your $3 share is refunded.' })], stop: 'tool_use' },
          { text: 'Refunded.' },
        ],
      }),
    )
    db = await openDb({ databaseUrl: null, pgliteDir: 'memory' })
    app = buildApp({ db, rateLimit: false })
    await app.ready()
  }, T)

  afterAll(async () => {
    // IDs and statuses only (no tokens or card data). ANSWERTAB_E2E_OUT names a file to keep them.
    if (process.env.ANSWERTAB_E2E_OUT) writeFileSync(process.env.ANSWERTAB_E2E_OUT, JSON.stringify(ids, null, 1))
    console.log(`\nE2E sandbox IDs:\n${JSON.stringify(ids, null, 1)}`)
    stopAllDetectors()
    setAnthropicClientForTests(undefined)
    setNowForTests(null)
    await app?.close()
    await db?.close()
  })

  it(
    'demo room -> holds -> questions -> answer -> settle -> replay -> verify -> contest refund -> payout',
    async () => {
      const demo = await call('POST', '/api/demo', { body: {} })
      expect(demo.status).toBe(201)
      const { roomId, creatorToken: ct, stripFans } = demo.body as { roomId: string; creatorToken: string; stripFans: { fanId: string; fanToken: string; displayName: string }[] }
      ids.roomId = roomId
      await demoTabsReady(roomId)
      const [asha, ben, chen] = stripFans as [(typeof stripFans)[0], (typeof stripFans)[0], (typeof stripFans)[0]]
      // A fifth fan holds but never asks: settled with a void.
      const eve = (await call('POST', `/api/rooms/${roomId}/fans`, { body: { displayName: 'Eve' } })).body
      await openBotTab(roomId, eve.fanId, { ceilingCents: 1000, card: botCard(1, 'Eve Test') })

      let cons = await call('GET', `/api/rooms/${roomId}/console`, { creator: ct })
      const holds = Object.fromEntries((cons.body.tabs as any[]).map((t) => [t.displayName, { state: t.state, orderId: t.orderId, authorizationId: t.authorizationId, declineReason: t.declineReason }]))
      ids.holds = holds
      expect(holds.Asha.state).toBe('held')
      expect(holds.Ben.state).toBe('held')
      expect(holds.Chen.state).toBe('held')
      expect(holds.Eve.state).toBe('held')
      expect(holds.Dev.state).toBe('declined')

      now += 10_000
      const q1 = await call('POST', `/api/rooms/${roomId}/questions`, { fan: asha.fanToken, body: { text: 'How should I split a big API project into folders?' } })
      expect(q1.status).toBe(201)
      now += 2_000
      expect((await call('POST', `/api/questions/${q1.body.id}/back`, { fan: ben.fanToken })).status).toBe(200)
      expect((await call('POST', `/api/questions/${q1.body.id}/back`, { fan: chen.fanToken })).status).toBe(200)
      expect((await call('POST', `/api/rooms/${roomId}/questions`, { fan: chen.fanToken, body: { text: 'Should tests live next to the code?' } })).status).toBe(201)

      const say = async (text: string) => {
        now += 12_000
        expect((await call('POST', `/api/rooms/${roomId}/segments`, { creator: ct, body: { text, final: true, source: 'typed' } })).status).toBe(200)
        await detectionIdle(roomId)
      }
      await say('Great question about folders, hold that thought.')
      await say('Okay, folders: one router file per feature, shared code in a core package.')
      await say("Tests: mostly next to the code, but let's do testing properly next week.")

      const review = await call('POST', `/api/rooms/${roomId}/end`, { creator: ct })
      expect(review.body.map((r: any) => r.state)).toEqual(['locked', 'review'])

      const settled = await call('POST', `/api/rooms/${roomId}/settle`, { creator: ct, body: { ratings: { '2': 'half' } } })
      expect(settled.status).toBe(200)
      expect(settled.body.errors).toEqual([])
      const tabs = Object.fromEntries((settled.body.tabs as any[]).map((t) => [t.displayName, t]))
      ids.settlement = Object.fromEntries(
        Object.entries(tabs).map(([k, t]: [string, any]) => [k, { state: t.state, captureId: t.captureId, capturedCents: t.capturedCents, feeCents: t.feeCents, releasedCents: t.releasedCents }]),
      )
      expect(tabs.Asha).toMatchObject({ state: 'captured', capturedCents: 600, releasedCents: 400 })
      expect(tabs.Ben).toMatchObject({ state: 'captured', capturedCents: 300, releasedCents: 700 })
      expect(tabs.Chen).toMatchObject({ state: 'captured', capturedCents: 600, releasedCents: 400 })
      expect(tabs.Eve).toMatchObject({ state: 'voided', releasedCents: 1000 })
      expect(tabs.Asha.feeCents).toBeGreaterThan(0)

      cons = await call('GET', `/api/rooms/${roomId}/console`, { creator: ct })
      const captureCall = (cons.body.ledger as any[]).find((l) => l.op === 'payments.capture' && l.resourceId === tabs.Asha.captureId)
      const replay = await call('POST', `/api/ledger/${captureCall.id}/replay`, { creator: ct })
      ids.replay = replay.body
      expect(replay.body.sameAsOriginal).toBe(true)

      const chenReceipt = (await call('GET', `/api/rooms/${roomId}/me`, { fan: chen.fanToken })).body.tab.receiptToken as string
      const verify = await call('POST', `/api/receipts/${chenReceipt}/verify`)
      ids.verify = { matches: verify.body.matches, authorization: verify.body.authorization, capture: verify.body.capture }
      expect(verify.body.matches).toBe(true)

      const receipt = await call('GET', `/api/receipts/${chenReceipt}`)
      const line = (receipt.body.lines as any[]).find((l) => l.questionNumber === 2)
      const contest = await call('POST', `/api/receipts/${chenReceipt}/contest`, { body: { backingId: line.backingId, reason: 'The testing part was postponed.' } })
      expect(contest.status).toBe(201)
      await contestsIdle()
      const after = await call('GET', `/api/receipts/${chenReceipt}`)
      const c = (after.body.lines as any[]).find((l) => l.questionNumber === 2).contest
      ids.contest = { id: c.id, state: c.state, refundId: c.refundId, refundCents: c.refundCents }
      expect(c).toMatchObject({ state: 'refunded', refundCents: 300 })

      const close = await call('POST', `/api/rooms/${roomId}/close-contest-window`, { creator: ct })
      expect(close.status).toBe(200)
      ids.payout = close.body.payout
      expect(close.body.payout.payoutBatchId).toBeTruthy()
      // Poll like the job would, for up to ~40 s of real time.
      for (let i = 0; i < 8; i++) {
        now += 11_000
        await runDueJobs()
        cons = await call('GET', `/api/rooms/${roomId}/console`, { creator: ct })
        if (cons.body.payout.state !== 'pending') break
        await new Promise((r) => setTimeout(r, 5_000))
      }
      ids.payoutFinal = cons.body.payout
      ids.ledgerCalls = (cons.body.ledger as any[]).length
      ids.debugIds = (cons.body.ledger as any[]).filter((l) => l.method === 'POST').map((l) => `${l.op} ${l.httpStatus} ${l.resourceId ?? '-'} ${l.debugId ?? '-'}`)
    },
    T,
  )
})
