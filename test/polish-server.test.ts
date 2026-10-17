// Polish pass, server side: webhook badges (tabs.capture_webhook_at, contests.refund_webhook_at, console
// webhooks list), partial quotes (questions.quote_truncated) and the env-driven per-IP room limit.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { RoomEvent, Segment } from '../src/shared/types.js'

vi.mock('../src/server/paypal/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/server/paypal/index.js')>()
  const { makeFakePayPal } = await import('../src/server/domain/testkit.js')
  return { ...actual, ...makeFakePayPal(actual) }
})

import * as paypal from '../src/server/paypal/index.js'
import { buildApp } from '../src/server/app.js'
import { resetConfigForTests } from '../src/server/config.js'
import { openDb, type Db } from '../src/server/db/db.js'
import { setAnthropicClientForTests } from '../src/server/ai/index.js'
import { createRoom, detectionIdle, onRoomEvent, roomsPerIpPerDay, setNowForTests, stopAllDetectors, webhooksIdle, type Audience } from '../src/server/domain/index.js'
import { quoteTruncated } from '../src/server/domain/detection.js'
import { routedClaude, type DetectRule, type FakePayPalState } from '../src/server/domain/testkit.js'

const fake = (paypal as unknown as { __fake: FakePayPalState }).__fake

let app: FastifyInstance
let db: Db
let T = Date.UTC(2026, 9, 16, 12, 0, 0)
const events: { roomId: string; event: RoomEvent; audience: Audience }[] = []

beforeAll(async () => {
  process.env.JUDGE_CODE = 'judge-code-for-tests'
  process.env.PAYPAL_CREATOR_PAYEE_EMAIL = 'creator-payee@example.com'
  // These tests deliver webhook events, so the app must have a webhook registered (receipts omit the badge otherwise).
  process.env.PAYPAL_WEBHOOK_ID = 'WH-TEST-POLISH'
  resetConfigForTests()
  setNowForTests(() => T)
  db = await openDb({ databaseUrl: null, pgliteDir: 'memory' })
  app = buildApp({ db, rateLimit: false })
  await app.ready()
  onRoomEvent((roomId, event, audience) => events.push({ roomId, event, audience }))
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
  events.length = 0
})

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

/** A live room with one held fan who asked Q1 and Q2, then both lines were typed and detected. */
async function answeredRoom(detect: DetectRule[]) {
  setAnthropicClientForTests(routedClaude({ intake: () => ({ allow: true, cues: [] }), detect }))
  const r = await call('POST', '/api/rooms', { body: { kind: 'demo', title: 'Office hours' } })
  const { roomId, creatorToken: ct } = r.body
  await call('POST', `/api/rooms/${roomId}/start`, { creator: ct })
  const f = (await call('POST', `/api/rooms/${roomId}/fans`, { body: { displayName: 'Asha' } })).body
  const o = await call('POST', `/api/rooms/${roomId}/tab/order`, { fan: f.fanToken, body: { ceilingCents: 2000, funding: 'card' } })
  fake.approve(o.body.orderId)
  await call('POST', `/api/rooms/${roomId}/tab/authorize`, { fan: f.fanToken, body: { orderId: o.body.orderId } })
  T += 5_000
  await call('POST', `/api/rooms/${roomId}/questions`, { fan: f.fanToken, body: { text: Q1 } })
  await call('POST', `/api/rooms/${roomId}/questions`, { fan: f.fanToken, body: { text: Q2 } })
  T += 10_000
  await call('POST', `/api/rooms/${roomId}/segments`, { creator: ct, body: { text: ANSWER, final: true, source: 'typed', lagMs: 0 } })
  await detectionIdle(roomId)
  T += 5_000
  await call('POST', `/api/rooms/${roomId}/segments`, { creator: ct, body: { text: PARTIAL, final: true, source: 'typed', lagMs: 0 } })
  await detectionIdle(roomId)
  return { roomId, ct, fan: f as { fanId: string; fanToken: string } }
}

const DETECT: DetectRule[] = [
  { question: 1, phrase: 'one router file per feature, shared code in a core package', verdict: 'answered', confidence: 0.95 },
  // Stops five words before the segment's end: too far for the guard's 1-2 word snap.
  { question: 2, phrase: 'mostly next to the code, but', verdict: 'partial', confidence: 0.8 },
]

async function settledRoom() {
  const x = await answeredRoom(DETECT)
  await call('POST', `/api/rooms/${x.roomId}/end`, { creator: x.ct })
  const s = await call('POST', `/api/rooms/${x.roomId}/settle`, { creator: x.ct, body: { ratings: { '2': 'half' } } })
  expect(s.body.room.status).toBe('settled')
  const me = (await call('GET', `/api/rooms/${x.roomId}/me`, { fan: x.fan.fanToken })).body
  return { ...x, tab: me.tab as { id: string; captureId: string; authorizationId: string; receiptToken: string } }
}

let evSeq = 0
function event(type: string, resource: unknown) {
  evSeq += 1
  return { id: `WH-polish-${evSeq}`, event_type: type, resource, create_time: new Date(T).toISOString() }
}

describe('webhook badges (P4)', () => {
  it('a verified capture event sets captureWebhookAt on the tab and receipt, lists in the console, and emits tab.updated', async () => {
    const { roomId, ct, tab } = await settledRoom()
    expect(tab.captureId).toMatch(/^CAP/)
    let receipt = (await call('GET', `/api/receipts/${tab.receiptToken}`)).body
    expect(receipt.tab.captureWebhookAt).toBeNull()

    // Unverified first: stored as id + type only, changes nothing, never listed.
    const capture = (await paypal.getCapture(tab.captureId)).raw
    fake.webhookVerifies = false
    const forged = event('PAYMENT.CAPTURE.COMPLETED', capture)
    expect((await call('POST', '/webhooks/paypal', { body: forged })).body).toMatchObject({ verified: false })
    await webhooksIdle()
    receipt = (await call('GET', `/api/receipts/${tab.receiptToken}`)).body
    expect(receipt.tab.captureWebhookAt).toBeNull()
    expect((await call('GET', `/api/rooms/${roomId}/console`, { creator: ct })).body.webhooks).toEqual([])

    fake.webhookVerifies = true
    events.length = 0
    T += 12_000
    const real = event('PAYMENT.CAPTURE.COMPLETED', capture)
    expect((await call('POST', '/webhooks/paypal', { body: real })).body).toMatchObject({ verified: true, duplicate: false })
    await webhooksIdle()
    receipt = (await call('GET', `/api/receipts/${tab.receiptToken}`)).body
    expect(receipt.tab.captureWebhookAt).toBe(new Date(T).toISOString())
    // Money is untouched: the capture was already booked from the settle response.
    expect(receipt.tab).toMatchObject({ state: 'captured', capturedCents: 900 })
    const updates = events.filter((e) => e.roomId === roomId && e.event.type === 'tab.updated')
    expect(updates.length).toBeGreaterThan(0)
    expect(updates.every((e) => e.event.type === 'tab.updated' && e.event.tab.captureWebhookAt === new Date(T).toISOString())).toBe(true)

    const consoleView = (await call('GET', `/api/rooms/${roomId}/console`, { creator: ct })).body
    expect(consoleView.webhooks).toEqual([{ id: real.id, eventType: 'PAYMENT.CAPTURE.COMPLETED', resourceId: tab.captureId, receivedAt: expect.any(String), verified: true }])
    expect(consoleView.tabs[0].captureWebhookAt).toBe(new Date(T).toISOString())

    // A later delivery for the same capture keeps the first confirmation time.
    const first = receipt.tab.captureWebhookAt
    T += 30_000
    await call('POST', '/webhooks/paypal', { body: event('PAYMENT.CAPTURE.COMPLETED', capture) })
    await webhooksIdle()
    expect((await call('GET', `/api/receipts/${tab.receiptToken}`)).body.tab.captureWebhookAt).toBe(first)
    expect((await call('GET', `/api/rooms/${roomId}/console`, { creator: ct })).body.webhooks).toHaveLength(2)
  })

  it('a verified refund event sets refundWebhookAt on the contest that issued it', async () => {
    const { roomId, ct, tab } = await settledRoom()
    const [b] = await db.query<{ id: string }>(`SELECT id FROM backings WHERE tab_id = $1 ORDER BY backed_at_ms DESC LIMIT 1`, [tab.id])
    await db.query(
      `INSERT INTO contests (id, room_id, tab_id, backing_id, reason, state, refund_id, refund_cents) VALUES ('ct-polish-1', $1, $2, $3, 'test', 'refunded', 'RF-POLISH-1', 300)`,
      [roomId, tab.id, b!.id],
    )
    fake.webhookVerifies = false
    await call('POST', '/webhooks/paypal', { body: event('PAYMENT.CAPTURE.REFUNDED', { id: 'RF-POLISH-1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '3.00' } }) })
    await webhooksIdle()
    let c = (await call('GET', `/api/rooms/${roomId}/console`, { creator: ct })).body.contests.find((x: { id: string }) => x.id === 'ct-polish-1')
    expect(c.refundWebhookAt).toBeNull()

    fake.webhookVerifies = true
    events.length = 0
    await call('POST', '/webhooks/paypal', { body: event('PAYMENT.CAPTURE.REFUNDED', { id: 'RF-POLISH-1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '3.00' } }) })
    await webhooksIdle()
    const view = (await call('GET', `/api/rooms/${roomId}/console`, { creator: ct })).body
    c = view.contests.find((x: { id: string }) => x.id === 'ct-polish-1')
    expect(c.refundWebhookAt).toBe(new Date(T).toISOString())
    expect(view.webhooks.map((w: { eventType: string }) => w.eventType)).toEqual(['PAYMENT.CAPTURE.REFUNDED'])
    expect(events.some((e) => e.event.type === 'contest.updated' && e.event.contest.refundWebhookAt === c.refundWebhookAt)).toBe(true)
    const receipt = (await call('GET', `/api/receipts/${tab.receiptToken}`)).body
    expect(receipt.lines.find((l: { contest: { id: string } | null }) => l.contest?.id === 'ct-polish-1').contest.refundWebhookAt).toBe(c.refundWebhookAt)
  })
})

describe('partial quotes (P18)', () => {
  const seg = (seq: number, text: string): Segment => ({ seq, text, words: text.split(/\s+/), tStartMs: 0, tEndMs: 1, source: 'typed', final: true })

  it('quoteTruncated: true only when the span stops before its end segment\'s last word', () => {
    const w = [seg(3, 'one two three four five six'), seg(4, 'seven eight nine')]
    expect(quoteTruncated({ startSeg: 3, startWord: 0, endSeg: 3, endWord: 5 }, w)).toBe(false)
    expect(quoteTruncated({ startSeg: 3, startWord: 0, endSeg: 3, endWord: 3 }, w)).toBe(true)
    expect(quoteTruncated({ startSeg: 3, startWord: 2, endSeg: 4, endWord: 2 }, w)).toBe(false)
    expect(quoteTruncated({ startSeg: 3, startWord: 2, endSeg: 4, endWord: 1 }, w)).toBe(true)
    expect(quoteTruncated(null, w)).toBe(false)
    expect(quoteTruncated({ startSeg: 9, startWord: 0, endSeg: 9, endWord: 0 }, w)).toBe(false)
  })

  it('is stored with the guard result and exposed on QuestionView, ReviewItem and ReceiptLine', async () => {
    const { roomId, ct, fan } = await answeredRoom(DETECT)
    const room = (await call('GET', `/api/rooms/${roomId}`)).body
    const q1 = room.questions.find((q: { number: number }) => q.number === 1)
    const q2 = room.questions.find((q: { number: number }) => q.number === 2)
    expect(q1).toMatchObject({ state: 'locked', quoteTruncated: false })
    expect(q2).toMatchObject({ state: 'review', quote: 'mostly next to the code, but', quoteTruncated: true })
    const review = (await call('POST', `/api/rooms/${roomId}/end`, { creator: ct })).body as { questionNumber: number; quoteTruncated: boolean }[]
    expect(review.find((r) => r.questionNumber === 2)!.quoteTruncated).toBe(true)
    expect(review.find((r) => r.questionNumber === 1)!.quoteTruncated).toBe(false)
    await call('POST', `/api/rooms/${roomId}/settle`, { creator: ct, body: { ratings: { '2': 'half' } } })
    const me = (await call('GET', `/api/rooms/${roomId}/me`, { fan: fan.fanToken })).body
    const receipt = (await call('GET', `/api/receipts/${me.tab.receiptToken}`)).body
    const line2 = receipt.lines.find((l: { questionNumber: number }) => l.questionNumber === 2)
    expect(line2).toMatchObject({ quote: 'mostly next to the code, but', quoteTruncated: true, rating: 'half' })
    expect(receipt.lines.find((l: { questionNumber: number }) => l.questionNumber === 1).quoteTruncated).toBe(false)
  })

  it('a creator-pointed span sets it too, and undo clears it', async () => {
    const { roomId, ct } = await answeredRoom([DETECT[0]!])
    const room = (await call('GET', `/api/rooms/${roomId}/console`, { creator: ct })).body
    const q2 = room.room.questions.find((q: { number: number }) => q.number === 2)
    const s = room.segments.find((x: Segment) => x.text === PARTIAL) as Segment
    const short = await call('POST', `/api/questions/${q2.id}/point`, { creator: ct, body: { span: { startSeg: s.seq, startWord: 1, endSeg: s.seq, endWord: 5 } } })
    expect(short.body).toMatchObject({ state: 'locked', creatorConfirmed: true, quoteTruncated: true })
    expect((await call('POST', `/api/questions/${q2.id}/undo`, { creator: ct })).body).toMatchObject({ state: 'open', quote: null, quoteTruncated: false })
    const full = await call('POST', `/api/questions/${q2.id}/point`, { creator: ct, body: { span: { startSeg: s.seq, startWord: 0, endSeg: s.seq, endWord: s.words.length - 1 } } })
    expect(full.body).toMatchObject({ state: 'locked', quoteTruncated: false })
  })
})

describe('ROOMS_PER_IP_PER_DAY (P16)', () => {
  it('defaults to 20 and follows the env', async () => {
    const prev = process.env.ROOMS_PER_IP_PER_DAY
    try {
      delete process.env.ROOMS_PER_IP_PER_DAY
      expect(roomsPerIpPerDay()).toBe(20)
      process.env.ROOMS_PER_IP_PER_DAY = 'abc'
      expect(roomsPerIpPerDay()).toBe(20)
      process.env.ROOMS_PER_IP_PER_DAY = '2'
      expect(roomsPerIpPerDay()).toBe(2)
      const ip = '203.0.113.77'
      await createRoom({ kind: 'public', ip })
      await createRoom({ kind: 'public', ip })
      await expect(createRoom({ kind: 'public', ip })).rejects.toMatchObject({ code: 'room_limit', status: 429, message: expect.stringContaining('2 public rooms') })
      await expect(createRoom({ kind: 'demo', ip, judgeCode: 'judge-code-for-tests' })).resolves.toMatchObject({ pool: 'judge' })
    } finally {
      if (prev === undefined) delete process.env.ROOMS_PER_IP_PER_DAY
      else process.env.ROOMS_PER_IP_PER_DAY = prev
    }
  })
})
