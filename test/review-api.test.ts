// Regression tests for the 2026-10-16 review (docs/review-2026-10-16.md), API and ops side: token redaction in
// logged URLs, webhook hardening, SSE admission, judge codes, room settings, /api/status's recorded run, console
// totals and boot recovery of settling rooms.
import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'

vi.mock('../src/server/paypal/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/server/paypal/index.js')>()
  const { makeFakePayPal } = await import('../src/server/domain/testkit.js')
  return { ...actual, ...makeFakePayPal(actual) }
})

import * as paypal from '../src/server/paypal/index.js'
import { buildApp, redactUrl } from '../src/server/app.js'
import { resetConfigForTests } from '../src/server/config.js'
import { openDb, type Db } from '../src/server/db/db.js'
import { setAnthropicClientForTests } from '../src/server/ai/index.js'
import { detectionIdle, resumeSettlingRooms, setNowForTests, stopAllDetectors, webhooksIdle } from '../src/server/domain/index.js'
import { routedClaude, type FakePayPalState } from '../src/server/domain/testkit.js'
import { plausibleWebhookHeaders } from '../src/server/paypal/webhooks.js'
import { runDueJobs } from '../src/server/jobs/index.js'
import { MAX_CLIENTS_PER_ROOM, MAX_STREAMS_PER_FAN, openStream } from '../src/server/sse.js'

const fake = (paypal as unknown as { __fake: FakePayPalState }).__fake

let app: FastifyInstance
let db: Db
let T = Date.UTC(2026, 9, 16, 12, 0, 0)

beforeAll(async () => {
  process.env.JUDGE_CODE = 'judge-code-for-tests'
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

beforeEach(() => fake.reset())

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

function claude() {
  setAnthropicClientForTests(
    routedClaude({
      intake: () => ({ allow: true, cues: ['folders'] }),
      detect: [{ question: 1, phrase: 'one router file per feature, shared code in a core package', verdict: 'answered', confidence: 0.95 }],
    }),
  )
}

async function settledRoom() {
  claude()
  const r = await call('POST', '/api/rooms', { body: { kind: 'demo', title: 'Office hours' } })
  const { roomId, creatorToken: ct } = r.body
  await call('POST', `/api/rooms/${roomId}/start`, { creator: ct })
  const f = (await call('POST', `/api/rooms/${roomId}/fans`, { body: { displayName: 'Asha' } })).body
  const o = await call('POST', `/api/rooms/${roomId}/tab/order`, { fan: f.fanToken, body: { ceilingCents: 1000, funding: 'card' } })
  fake.approve(o.body.orderId)
  await call('POST', `/api/rooms/${roomId}/tab/authorize`, { fan: f.fanToken, body: { orderId: o.body.orderId } })
  T += 5_000
  await call('POST', `/api/rooms/${roomId}/questions`, { fan: f.fanToken, body: { text: 'How should I split a big API project into folders?' } })
  T += 10_000
  await call('POST', `/api/rooms/${roomId}/segments`, { creator: ct, body: { text: 'Okay, folders: one router file per feature, shared code in a core package.', final: true, source: 'typed', lagMs: 0 } })
  await detectionIdle(roomId)
  await call('POST', `/api/rooms/${roomId}/end`, { creator: ct })
  return { roomId, ct, fan: f }
}

describe('token redaction in logged URLs (money F4 / judge F3)', () => {
  it('masks token=, k=, t= and the fan page ?t=, whatever the order', () => {
    const c = 'CREATORxxxxxxxxxxxxxxxxxxxxxxxxx'
    const f = 'FANyyyyyyyyyyyyyyyyyyyyyyyyyyyyy'
    const creatorSse = `/api/rooms/AbCdEfGhJk/events?${new URLSearchParams({ token: c, k: c, role: 'creator' })}`
    const fanSse = `/api/rooms/AbCdEfGhJk/events?${new URLSearchParams({ role: 'fan', t: f, token: f })}`
    for (const url of [creatorSse, fanSse, `/f/AbCdEfGhJk?t=${f}&embed=1`, `/c/AbCdEfGhJk?K=${c}`]) {
      const out = redactUrl(url)
      expect(out).not.toContain(c)
      expect(out).not.toContain(f)
      expect(out).toContain('REDACTED')
    }
    expect(redactUrl(fanSse)).toBe('/api/rooms/AbCdEfGhJk/events?role=fan&t=REDACTED&token=REDACTED')
    expect(redactUrl('/api/rooms/AbCdEfGhJk/events?role=creator')).toBe('/api/rooms/AbCdEfGhJk/events?role=creator')
  })
})

describe('webhooks (money F10, F11)', () => {
  const now = Date.UTC(2026, 9, 16, 12, 0, 0)
  const ok = { 'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1', 'paypal-transmission-time': new Date(now - 60_000).toISOString() }

  it('checks the cert URL and transmission time before any PayPal call', () => {
    expect(plausibleWebhookHeaders(ok, now)).toBe(true)
    expect(plausibleWebhookHeaders({ ...ok, 'paypal-cert-url': 'https://api.paypal.com/v1/notifications/certs/X' }, now)).toBe(true)
    expect(plausibleWebhookHeaders({ ...ok, 'paypal-cert-url': 'http://api.sandbox.paypal.com/certs' }, now)).toBe(false)
    expect(plausibleWebhookHeaders({ ...ok, 'paypal-cert-url': 'https://api.sandbox.paypal.com.evil.example/certs' }, now)).toBe(false)
    expect(plausibleWebhookHeaders({ ...ok, 'paypal-transmission-time': new Date(now - 3 * 24 * 3600_000).toISOString() }, now)).toBe(false)
    expect(plausibleWebhookHeaders({ ...ok, 'paypal-transmission-time': 'yesterday' }, now)).toBe(false)
    expect(plausibleWebhookHeaders({}, now)).toBe(false)
  })

  it('answers 503 when verification is unavailable, so PayPal delivers again', async () => {
    fake.webhookVerifies = 'unknown'
    const ev = { id: 'WH-retry-1', event_type: 'CUSTOMER.DISPUTE.CREATED', resource: { dispute_id: 'PP-D-9' } }
    const r = await call('POST', '/webhooks/paypal', { body: ev })
    expect(r.status).toBe(503)
    expect(r.body.error.code).toBe('verify_unavailable')
    expect(await db.query(`SELECT 1 FROM webhook_events WHERE id = 'WH-retry-1'`)).toHaveLength(0)
    fake.webhookVerifies = true
    expect((await call('POST', '/webhooks/paypal', { body: ev })).body).toMatchObject({ verified: true, duplicate: false })
    await webhooksIdle()
  })

  it('stores only the id and type of an unverified event, and the full body once it verifies', async () => {
    fake.webhookVerifies = false
    const ev = { id: 'WH-big-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP-X', padding: 'x'.repeat(20_000) } }
    expect((await call('POST', '/webhooks/paypal', { body: ev })).body).toMatchObject({ verified: false })
    const [row] = await db.query<{ payload: unknown; resource_id: string | null }>(`SELECT payload, resource_id FROM webhook_events WHERE id = 'WH-big-1'`)
    expect(row).toEqual({ payload: { id: 'WH-big-1', event_type: 'PAYMENT.CAPTURE.COMPLETED' }, resource_id: null })
    fake.webhookVerifies = true
    expect((await call('POST', '/webhooks/paypal', { body: ev })).body).toMatchObject({ verified: true, duplicate: false })
    await webhooksIdle()
    const [up] = await db.query<{ payload: any; verified: boolean }>(`SELECT payload, verified FROM webhook_events WHERE id = 'WH-big-1'`)
    expect(up!.verified).toBe(true)
    expect(up!.payload.resource.id).toBe('CAP-X')
  })
})

describe('SSE admission (money F14)', () => {
  function fakeRes(): ServerResponse & { status?: number } {
    const e = new EventEmitter() as unknown as ServerResponse & { status?: number }
    Object.assign(e, { writableEnded: false, destroyed: false, writeHead: (s: number) => ((e as { status?: number }).status = s), write: () => true, end: () => undefined })
    return e
  }

  it('always admits the creator, and caps streams per fan and per IP', () => {
    const roomId = 'SseRoom001'
    const opened: ServerResponse[] = []
    for (let i = 0; i < MAX_CLIENTS_PER_ROOM; i++) {
      const res = fakeRes()
      expect(openStream(res, { roomId, role: 'public', fanId: null, ip: `198.51.100.${i % 200}-${Math.floor(i / 200)}`, initial: [] })).toBeNull()
      opened.push(res)
    }
    expect(openStream(fakeRes(), { roomId, role: 'public', fanId: null, ip: '203.0.113.1', initial: [] })).toBe('too_many_viewers')
    expect(openStream(fakeRes(), { roomId, role: 'creator', fanId: null, ip: '203.0.113.1', initial: [] })).toBeNull()
    for (const r of opened) r.emit('close')

    for (let i = 0; i < MAX_STREAMS_PER_FAN; i++) expect(openStream(fakeRes(), { roomId, role: 'fan', fanId: 'fan_1', ip: `192.0.2.${i}`, initial: [] })).toBeNull()
    expect(openStream(fakeRes(), { roomId, role: 'fan', fanId: 'fan_1', ip: '192.0.2.99', initial: [] })).toBe('too_many_streams')
  })
})

describe('judge codes and room limits (judge F15)', () => {
  it('a wrong judge code is a 403; no code uses the public pool', async () => {
    const bad = await call('POST', '/api/demo', { body: { judgeCode: 'not-the-code' } })
    expect(bad.status).toBe(403)
    expect(bad.body.error.code).toBe('bad_judge_code')
    const none = await call('POST', '/api/demo', { body: {} })
    expect(none.status).toBe(201)
    expect(none.body.pool).toBe('public')
    const good = await call('POST', '/api/demo', { body: { judgeCode: 'judge-code-for-tests' } })
    expect(good.body.pool).toBe('judge')
  })
})

describe('room settings (judge F24)', () => {
  it('the creator sets the speech language before or during the stream', async () => {
    const r = await call('POST', '/api/rooms', { body: { kind: 'public', title: 'Mic take' } })
    const { roomId, creatorToken: ct } = r.body
    const set = await call('POST', `/api/rooms/${roomId}/settings`, { creator: ct, body: { language: 'en-IN' } })
    expect(set.status).toBe(200)
    expect(set.body).toMatchObject({ id: roomId, language: 'en-IN', status: 'draft' })
    expect((await call('POST', `/api/rooms/${roomId}/settings`, { creator: ct, body: { language: 'xx-YY' } })).status).toBe(400)
    expect((await call('POST', `/api/rooms/${roomId}/settings`, { body: { language: 'en-GB' } })).status).toBe(401)
    await call('POST', `/api/rooms/${roomId}/start`, { creator: ct })
    expect((await call('POST', `/api/rooms/${roomId}/settings`, { creator: ct, body: { language: 'en-GB' } })).body.language).toBe('en-GB')
    await call('POST', `/api/rooms/${roomId}/end`, { creator: ct })
    expect((await call('POST', `/api/rooms/${roomId}/settings`, { creator: ct, body: { language: 'en-US' } })).status).toBe(409)
  })
})

describe('/api/status recorded run (judge F10)', () => {
  it('returns the newest passed synthetic run with PayPal IDs and statuses only', async () => {
    expect((await call('GET', '/api/status')).body.lastPassedRun).toBeNull()
    const details = {
      timings: { settled: 41000, total: 90000 },
      paypal: {
        tabs: [{ fan: 'Asha', state: 'captured', authStatus: 'CAPTURED', orderId: 'O1', authorizationId: 'A1', captureId: 'C1', capturedCents: 600 }],
        refund: { contestId: 'ct1', state: 'refunded', refundId: 'R1', refundCents: 300 },
        payout: { payoutBatchId: 'PB1', batchStatus: 'SUCCESS', state: 'success' },
      },
    }
    await db.query(`INSERT INTO synthetic_runs (id, started_at, finished_at, ok, room_id, details) VALUES ('syn_old', now(), now() - interval '2 hours', true, 'RoomOld001', '{}'::jsonb)`)
    await db.query(`INSERT INTO synthetic_runs (id, started_at, finished_at, ok, room_id, details) VALUES ('syn_new', now(), now(), true, 'RoomNew001', $1::jsonb)`, [JSON.stringify(details)])
    await db.query(`INSERT INTO synthetic_runs (id, started_at, finished_at, ok, room_id, details) VALUES ('syn_bad', now(), now() + interval '1 minute', false, 'RoomBad001', '{}'::jsonb)`)
    const s = (await call('GET', '/api/status')).body
    expect(s.lastPassedRun).toMatchObject({
      id: 'syn_new',
      roomId: 'RoomNew001',
      steps: [
        { name: 'Asha: hold', paypalId: 'A1', status: 'CAPTURED' },
        { name: 'Asha: capture', paypalId: 'C1', status: 'captured' },
        { name: 'contest refund', paypalId: 'R1', status: 'refunded' },
        { name: 'creator payout', paypalId: 'PB1', status: 'SUCCESS' },
      ],
      timings: { settled: 41000, total: 90000 },
    })
    expect(Array.isArray(s.checks)).toBe(true)
  })
})

describe('console totals and settle errors (judge F23, F17)', () => {
  it('the console gives PayPal-number totals; the settle response always carries errors[]', async () => {
    const { roomId, ct } = await settledRoom()
    const s = await call('POST', `/api/rooms/${roomId}/settle`, { creator: ct, body: {} })
    expect(s.body.errors).toEqual([])
    const v = (await call('GET', `/api/rooms/${roomId}/console`, { creator: ct })).body
    expect(v.totals).toEqual({ grossCents: 600, feeCents: 46, refundedCents: 0, netCents: 554 })
    expect(v.tabs[0].refundedCents).toBe(0)
  })
})

describe('boot recovery of settling rooms (money F5 / judge F17)', () => {
  it('a room a restart left in settling is resumed by the sweeper', async () => {
    const { roomId, ct } = await settledRoom()
    // Simulate a crash right after the ratings were applied: room settling, tab still held.
    await call('POST', `/api/rooms/${roomId}/settle`, { creator: ct, body: {} })
    await db.query(`UPDATE rooms SET status = 'settling' WHERE id = $1`, [roomId])
    await db.query(`UPDATE tabs SET state = 'held', capture_id = NULL WHERE room_id = $1`, [roomId])
    await db.query(`UPDATE backings SET state = 'reserved' WHERE room_id = $1`, [roomId])
    expect(await resumeSettlingRooms()).toBeGreaterThanOrEqual(1)
    for (let i = 0; i < 10 && (await runDueJobs()) > 0; i++) {
      // sweep
    }
    expect((await call('GET', `/api/rooms/${roomId}`)).body.status).toBe('settled')
    // The capture replayed with the same PayPal-Request-Id: one capture at PayPal.
    expect(fake.captures.size).toBe(1)
  })
})
