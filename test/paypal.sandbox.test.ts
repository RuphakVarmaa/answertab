// Real PayPal sandbox integration test. Runs only with PAYPAL_SANDBOX_IT=1 (reads .env itself):
//   PAYPAL_SANDBOX_IT=1 npx vitest run test/paypal.sandbox.test.ts
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resetConfigForTests } from '../src/server/config.js'
import { openDb, setDb, type Db } from '../src/server/db/db.js'
import { base58 } from '../src/server/ids.js'
import { resetPayPalClientForTests } from '../src/server/paypal/client.js'
import * as pp from '../src/server/paypal/index.js'

const RUN = process.env.PAYPAL_SANDBOX_IT === '1'
const T = 90_000

describe.skipIf(!RUN)('PayPal sandbox (real calls)', () => {
  let db: Db
  const roomId = `it${base58(8)}`
  const fan = (n: number) => `fan_${n}${base58(6)}`
  const fanA = fan(1)
  const fanB = fan(2)
  const fanC = fan(3)
  const contestId = `ct_${base58(10)}`
  const s: {
    authA?: string
    captureId?: string
    captureCallId?: string
    authB?: string
  } = {}
  const ledger: pp.LedgerEvent[] = []

  beforeAll(async () => {
    if (existsSync('.env')) process.loadEnvFile('.env')
    resetConfigForTests()
    resetPayPalClientForTests()
    db = await openDb({ databaseUrl: null, pgliteDir: 'memory' })
    setDb(db)
    await db.query(`INSERT INTO rooms (id, creator_token_hash, title, kind, pool, question_price_cents, metoo_price_cents) VALUES ($1, 'h', 'IT room', 'demo', 'judge', 300, 100)`, [roomId])
    for (const [f, i] of [[fanA, 1], [fanB, 2], [fanC, 3]] as const) {
      await db.query(`INSERT INTO fans (id, room_id, display_name, fan_token, is_bot) VALUES ($1, $2, $3, $4, true)`, [f, roomId, `Bot ${i}`, `tok-${f}`])
      await db.query(`INSERT INTO tabs (id, room_id, fan_id, ceiling_cents, funding) VALUES ($1, $2, $3, 2000, 'bot_card')`, [`tab_${f}`, roomId, f])
    }
    await db.query(
      `INSERT INTO questions (id, room_id, number, asker_fan_id, text, clean_text, asked_at_ms) VALUES ('q_it', $1, 1, $2, 'q', 'q', 0)`,
      [roomId, fanA],
    )
    await db.query(`INSERT INTO backings (id, question_id, room_id, fan_id, tab_id, kind, amount_cents, backed_at_ms) VALUES ('b_it', 'q_it', $1, $2, $3, 'ask', 300, 0)`, [roomId, fanA, `tab_${fanA}`])
    await db.query(`INSERT INTO contests (id, room_id, tab_id, backing_id, reason) VALUES ($1, $2, $3, 'b_it', 'not answered')`, [contestId, roomId, `tab_${fanA}`])
    pp.onLedgerCall((e) => ledger.push(e))
  }, T)

  afterAll(async () => {
    const rows = await db.query<{ op: string; http_status: number; request_id: string | null; resource_id: string | null; resource_status: string | null; debug_id: string | null; latency_ms: number; tab_id: string | null }>(
      `SELECT op, http_status, request_id, resource_id, resource_status, debug_id, latency_ms, tab_id FROM paypal_calls ORDER BY created_at, id`,
    )
    // Evidence for docs/sandbox-capabilities.md: IDs, statuses and debug ids only (rows are already redacted).
    mkdirSync('scripts/sandbox-proof/out', { recursive: true })
    writeFileSync('scripts/sandbox-proof/out/it-latest.json', JSON.stringify({ roomId, at: new Date().toISOString(), calls: rows }, null, 1))
    await db?.close()
  })

  it('bot_card AUTHORIZE returns COMPLETED + authorization CREATED in one call', async () => {
    const o = await pp.createAuthorizeOrder({ roomId, fanId: fanA, ceilingCents: 2000, funding: 'bot_card', botCard: pp.botCard(0) })
    expect(o.status).toBe('COMPLETED')
    expect(o.authStatus).toBe('CREATED')
    expect(o.authorizationId).toMatch(/^[A-Z0-9]{17}$/)
    expect(o.expiresAt).toBeTruthy()
    expect(JSON.stringify(o.raw)).not.toContain(pp.TEST_CARDS[0]!.number)
    s.authA = o.authorizationId!
  }, T)

  it('captureTab: one partial capture with final_capture, fees from PayPal', async () => {
    const c = await pp.captureTab({ roomId, fanId: fanA, authorizationId: s.authA!, amountCents: 700, noteToPayer: 'AnswerTab: Q1 answered on stream. Receipt: https://example.invalid/r/x' })
    expect(c.status).toBe('COMPLETED')
    expect(c.finalCapture).toBe(true)
    expect(c.grossCents).toBe(700)
    expect(c.feeCents).toBeGreaterThan(0)
    expect(c.netCents).toBe(c.grossCents - c.feeCents!)
    s.captureId = c.captureId
    s.captureCallId = c.ledgerCallId
    const got = await pp.getCapture(c.captureId, { roomId, fanId: fanA })
    expect(got.captureId).toBe(c.captureId)
    expect(got.status).toBe('COMPLETED')
    const auth = await pp.getAuthorization(s.authA!, { roomId, fanId: fanA })
    expect(auth.status).toBe('CAPTURED')
  }, T)

  it('replayCapture resends with the same PayPal-Request-Id and gets the same capture', async () => {
    const r = await pp.replayCapture(s.captureCallId!)
    expect(r.sameAsOriginal).toBe(true)
    expect(r.captureId).toBe(s.captureId)
  }, T)

  it('a second tab is voided', async () => {
    const o = await pp.createAuthorizeOrder({ roomId, fanId: fanB, ceilingCents: 1000, funding: 'bot_card', botCard: pp.botCard(1) })
    expect(o.authStatus).toBe('CREATED')
    const v = await pp.voidTab({ roomId, fanId: fanB, authorizationId: o.authorizationId! })
    expect(v.status).toBe('VOIDED')
  }, T)

  it('CCREJECT-REFUSED: HTTP 201, order COMPLETED, authorization DENIED', async () => {
    const o = await pp.createAuthorizeOrder({ roomId, fanId: fanC, ceilingCents: 1000, funding: 'bot_card', botCard: pp.declineCard() })
    expect(o.status).toBe('COMPLETED')
    expect(o.authStatus).toBe('DENIED')
    expect(o.declineReason).toMatch(/Not charged/)
    expect(pp.isDeclined(o.raw)).toBe(true)
  }, T)

  it('refundShare: partial refund with an explicit amount via the Agent Toolkit, then get_refund', async () => {
    const r = await pp.refundShare({ contestId, captureId: s.captureId!, amountCents: 300, noteToPayer: 'AnswerTab: contest upheld for Q1, $3.00 back.' })
    expect(r.status).toBe('COMPLETED')
    expect(r.grossCents).toBe(300)
    expect(r.captureId).toBe(s.captureId)
    expect(r.path).toBe('toolkit')
    const ops = ledger.map((e) => e.call.op)
    expect(ops).toContain('refunds.create:toolkit')
    expect(ops).toContain('refunds.get:toolkit')
    const created = ledger.find((e) => e.call.op === 'refunds.create:toolkit')!
    expect(created.call.requestId).toBe(`refund-${contestId}`)
    expect(created.call.tabId).toBe(`tab_${fanA}`)
    expect(created.roomId).toBe(roomId)
  }, T)

  it('getOrder via the toolkit shows the captured authorization', async () => {
    const orderId = ledger.find((e) => e.call.op === 'orders.create' && e.call.tabId === `tab_${fanA}`)!.call.resourceId!
    const o = await pp.getOrder(orderId, { roomId, fanId: fanA })
    expect(o.authStatus).toBe('CAPTURED')
    expect(o.captureIds).toContain(s.captureId)
  }, T)

  it('payout to the US sandbox creator, then getPayoutBatch', async () => {
    const email = process.env.PAYPAL_CREATOR_PAYEE_EMAIL
    expect(email, 'PAYPAL_CREATOR_PAYEE_EMAIL').toBeTruthy()
    const p = await pp.createPayout({ roomId, attempt: 1, receiverEmail: email!, amountCents: 100, note: 'AnswerTab IT payout' })
    expect(p.payoutBatchId).toBeTruthy()
    expect(['PENDING', 'PROCESSING', 'SUCCESS']).toContain(p.batchStatus)
    const b = await pp.getPayoutBatch(p.payoutBatchId, { roomId })
    expect(b.payoutBatchId).toBe(p.payoutBatchId)
    expect(b.senderBatchId).toBe(`payout-${roomId}-1`)
    expect(b.items).toHaveLength(1)
  }, T)

  it('the ledger holds every call, linked to tabs, with no secrets', async () => {
    const rows = await db.query(`SELECT * FROM paypal_calls`)
    const dump = JSON.stringify(rows)
    for (const c of pp.TEST_CARDS) expect(dump).not.toContain(c.number)
    expect(dump).not.toContain(process.env.PAYPAL_CLIENT_SECRET!)
    expect(dump).not.toContain(process.env.PAYPAL_CREATOR_PAYEE_EMAIL!)
    expect(dump).not.toMatch(/Bearer [A-Za-z0-9]/)
    expect(dump).not.toMatch(/A21AA[A-Za-z0-9_-]{20,}/)
    const capture = (rows as { op: string; tab_id: string | null; request_id: string | null }[]).find((r) => r.op === 'payments.capture')!
    expect(capture.tab_id).toBe(`tab_${fanA}`)
    expect(capture.request_id).toBe(`settle-${roomId}-${fanA}`)
  }, T)
})
