// Typed-fetch transport with a stubbed fetch: token cache, 401 refresh, webhook verification and
// registration, payout duplicate recovery. No network.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetConfigForTests } from '../src/server/config.js'
import { openDb, setDb, type Db } from '../src/server/db/db.js'
import { resetPayPalClientForTests } from '../src/server/paypal/client.js'
import { getBalances, createPayout } from '../src/server/paypal/payouts.js'
import { buildVerifyBody, ensureWebhook, verifyWebhook, WEBHOOK_EVENT_TYPES } from '../src/server/paypal/webhooks.js'

type Handler = (url: URL, init: RequestInit) => { status: number; body?: unknown; headers?: Record<string, string> }
let handler: Handler
const calls: { method: string; path: string; body: string | null; auth: string | null }[] = []

function json(status: number, body?: unknown, headers: Record<string, string> = {}) {
  return { status, body, headers: { 'paypal-debug-id': `dbg-${calls.length}`, ...headers } }
}

let db: Db
beforeAll(async () => {
  db = await openDb({ databaseUrl: null, pgliteDir: 'memory' })
  setDb(db)
  await db.query(`INSERT INTO rooms (id, creator_token_hash, title, kind, pool, question_price_cents, metoo_price_cents) VALUES ('RoomP', 'h', 'T', 'demo', 'judge', 300, 100)`)
})
afterAll(async () => {
  await db.close()
})

beforeEach(() => {
  calls.length = 0
  resetPayPalClientForTests()
  vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const headers = new Headers(init.headers)
    calls.push({ method: init.method ?? 'GET', path: url.pathname, body: typeof init.body === 'string' ? init.body : null, auth: headers.get('authorization') })
    const r = handler(url, init)
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json', ...r.headers } })
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.PAYPAL_WEBHOOK_ID
  resetConfigForTests()
})

let tokenN = 0
function tokenResponse() {
  tokenN++
  return json(200, { access_token: `A21AAtest-token-${tokenN}-xxxxxxxxxxxxxxxx`, token_type: 'Bearer', expires_in: 32400, scope: 'a b c' })
}

describe('OAuth token cache', () => {
  it('fetches one token for many calls and never stores it in the ledger', async () => {
    handler = (url) => (url.pathname === '/v1/oauth2/token' ? tokenResponse() : json(200, { balances: [{ currency: 'USD', total_balance: { currency_code: 'USD', value: '5000.00' } }] }))
    const [a, b] = await Promise.all([getBalances(), getBalances()])
    await getBalances()
    expect(a.balances[0]).toMatchObject({ currency: 'USD', totalCents: 500000 })
    expect(b.balances).toHaveLength(1)
    expect(calls.filter((c) => c.path === '/v1/oauth2/token')).toHaveLength(1)
    expect(calls.find((c) => c.path === '/v1/oauth2/token')!.auth).toMatch(/^Basic /)
    const rows = await db.query<{ op: string; response_redacted: unknown }>(`SELECT op, response_redacted FROM paypal_calls`)
    expect(rows.some((r) => r.op === 'oauth.token')).toBe(true)
    expect(JSON.stringify(rows)).not.toContain('A21AAtest-token')
  })

  it('refreshes the token after a 401 and retries once', async () => {
    let balanceCalls = 0
    handler = (url) => {
      if (url.pathname === '/v1/oauth2/token') return tokenResponse()
      balanceCalls++
      return balanceCalls === 1 ? json(401, { error: 'invalid_token', error_description: 'Token signature verification failed' }) : json(200, { balances: [] })
    }
    await expect(getBalances()).resolves.toMatchObject({ balances: [] })
    const tokenCalls = calls.filter((c) => c.path === '/v1/oauth2/token')
    expect(tokenCalls).toHaveLength(2)
    const balanceAuths = calls.filter((c) => c.path === '/v1/reporting/balances').map((c) => c.auth)
    expect(balanceAuths[0]).not.toBe(balanceAuths[1])
  })

  it('a second 401 surfaces as PayPalError', async () => {
    handler = (url) => (url.pathname === '/v1/oauth2/token' ? tokenResponse() : json(401, { error: 'invalid_token' }))
    await expect(getBalances()).rejects.toMatchObject({ name: 'invalid_token', httpStatus: 401 })
  })
})

describe('webhooks', () => {
  const headers = {
    'paypal-auth-algo': 'SHA256withRSA',
    'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1',
    'paypal-transmission-id': 't-1',
    'paypal-transmission-sig': 'sig==',
    'paypal-transmission-time': new Date().toISOString(),
  }
  // Key order and spacing that JSON.stringify(JSON.parse(x)) would not preserve.
  const raw = '{"id":"WH-1","event_type":"PAYMENT.CAPTURE.COMPLETED", "resource":{"amount":{"value":"7.00"},"b":1,"a":2}}'

  it('splices the raw body in byte-for-byte', () => {
    const body = buildVerifyBody(headers, raw, 'WEBHOOK123')!
    expect(body.endsWith(`"webhook_event":${raw}}`)).toBe(true)
    expect(JSON.parse(body)).toMatchObject({ auth_algo: 'SHA256withRSA', webhook_id: 'WEBHOOK123', transmission_id: 't-1' })
    expect(buildVerifyBody({ ...headers, 'paypal-transmission-sig': undefined } as never, raw, 'W')).toBeNull()
    expect(buildVerifyBody(headers, 'not json', 'W')).toBeNull()
  })

  it('returns true only on SUCCESS', async () => {
    process.env.PAYPAL_WEBHOOK_ID = 'WEBHOOK123'
    resetConfigForTests()
    let status = 'SUCCESS'
    handler = (url) => (url.pathname === '/v1/oauth2/token' ? tokenResponse() : json(200, { verification_status: status }))
    expect(await verifyWebhook(headers, Buffer.from(raw))).toBe(true)
    const sent = calls.find((c) => c.path === '/v1/notifications/verify-webhook-signature')!.body!
    expect(sent).toContain(raw)
    status = 'FAILURE'
    expect(await verifyWebhook(headers, raw)).toBe(false)
  })

  it('rejects without a webhook id or headers, without calling PayPal', async () => {
    handler = () => json(500)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await verifyWebhook(headers, raw)).toBe(false)
    warn.mockRestore()
    process.env.PAYPAL_WEBHOOK_ID = 'WEBHOOK123'
    resetConfigForTests()
    expect(await verifyWebhook({}, raw)).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('PATCHes event_types on an existing webhook instead of creating one', async () => {
    const url = 'https://answertab.example.com/webhooks/paypal'
    handler = (u, init) => {
      if (u.pathname === '/v1/oauth2/token') return tokenResponse()
      if (init.method === 'GET') return json(200, { webhooks: [{ id: 'WH-OTHER', url: 'https://other.example.com/x', event_types: [] }, { id: 'WH-1', url, event_types: [{ name: 'PAYMENT.CAPTURE.COMPLETED' }] }] })
      if (init.method === 'PATCH') return json(200, { id: 'WH-1', url, event_types: JSON.parse(String(init.body))[0].value })
      return json(500)
    }
    const r = await ensureWebhook(url)
    expect(r).toMatchObject({ webhookId: 'WH-1', created: false })
    expect(r.eventTypes).toEqual([...WEBHOOK_EVENT_TYPES])
    const patch = calls.find((c) => c.method === 'PATCH')!
    expect(patch.path).toBe('/v1/notifications/webhooks/WH-1')
    expect(JSON.parse(patch.body!)[0]).toMatchObject({ op: 'replace', path: '/event_types' })
    expect(calls.some((c) => c.method === 'POST' && c.path === '/v1/notifications/webhooks')).toBe(false)
  })

  it('creates the webhook only when none has the URL; refuses non-https', async () => {
    handler = (u, init) => {
      if (u.pathname === '/v1/oauth2/token') return tokenResponse()
      if (init.method === 'GET') return json(200, { webhooks: [] })
      return json(201, { id: 'WH-NEW', url: 'https://a.example.com/webhooks/paypal', event_types: JSON.parse(String(init.body)).event_types })
    }
    await expect(ensureWebhook('https://a.example.com/webhooks/paypal')).resolves.toMatchObject({ webhookId: 'WH-NEW', created: true })
    await expect(ensureWebhook('http://localhost:8787/webhooks/paypal')).rejects.toMatchObject({ name: 'INVALID_ARGUMENT' })
  })
})

describe('payouts', () => {
  it('sends payout-{room}-{attempt} as sender_batch_id and request id, and stores payout_batch_id', async () => {
    await db.query(`INSERT INTO payouts (id, room_id, attempt, sender_batch_id, receiver, amount_cents) VALUES ('po_1', 'RoomP', 1, 'payout-RoomP-1', 'x', 100)`)
    handler = (u) => (u.pathname === '/v1/oauth2/token' ? tokenResponse() : json(201, { batch_header: { payout_batch_id: 'BATCH1', batch_status: 'PENDING', sender_batch_header: { sender_batch_id: 'payout-RoomP-1' } } }))
    const r = await createPayout({ roomId: 'RoomP', attempt: 1, receiverEmail: 'sb-test@personal.example.com', amountCents: 100, note: 'Payout' })
    expect(r).toMatchObject({ payoutBatchId: 'BATCH1', batchStatus: 'PENDING', senderBatchId: 'payout-RoomP-1', recovered: false })
    const sent = JSON.parse(calls.find((c) => c.path === '/v1/payments/payouts')!.body!)
    expect(sent.sender_batch_header.sender_batch_id).toBe('payout-RoomP-1')
    expect(sent.items[0]).toMatchObject({ recipient_type: 'EMAIL', amount: { value: '1.00', currency: 'USD' }, sender_item_id: 'payout-RoomP-1-1' })
    const [row] = await db.query<{ payout_batch_id: string }>(`SELECT payout_batch_id FROM payouts WHERE id = 'po_1'`)
    expect(row!.payout_batch_id).toBe('BATCH1')
    const ledger = await db.query<{ request_redacted: unknown }>(`SELECT request_redacted FROM paypal_calls WHERE op = 'payouts.create'`)
    expect(JSON.stringify(ledger)).not.toContain('sb-test@personal.example.com')
  })

  it('answers a duplicate sender_batch_id from the stored batch id', async () => {
    handler = (u, init) => {
      if (u.pathname === '/v1/oauth2/token') return tokenResponse()
      if (init.method === 'POST') {
        return json(400, { name: 'USER_BUSINESS_ERROR', message: 'User business error.', debug_id: 'f640099446bff', details: [{ field: 'SENDER_BATCH_ID', location: 'body', issue: 'Batch with given sender_batch_id already exists' }] })
      }
      return json(200, { batch_header: { payout_batch_id: 'BATCH1', batch_status: 'SUCCESS', sender_batch_header: { sender_batch_id: 'payout-RoomP-1' } }, items: [] })
    }
    const r = await createPayout({ roomId: 'RoomP', attempt: 1, receiverEmail: 'sb-test@personal.example.com', amountCents: 100, note: 'Payout' })
    expect(r).toMatchObject({ payoutBatchId: 'BATCH1', batchStatus: 'SUCCESS', recovered: true })
    await expect(createPayout({ roomId: 'RoomP', attempt: 9, receiverEmail: 'sb-test@personal.example.com', amountCents: 100, note: 'Payout' })).rejects.toMatchObject({
      name: 'USER_BUSINESS_ERROR',
      httpStatus: 400,
    })
  })

  it('without a stored row, follows the original batch linked in details[].link', async () => {
    handler = (u, init) => {
      if (u.pathname === '/v1/oauth2/token') return tokenResponse()
      if (init.method === 'POST') {
        return json(400, {
          name: 'USER_BUSINESS_ERROR',
          links: [],
          details: [{ field: 'SENDER_BATCH_ID', issue: 'Batch with given sender_batch_id already exists', link: [{ rel: 'self', href: 'https://api.sandbox.paypal.com/v1/payments/payouts/BATCH7', method: 'GET' }] }],
        })
      }
      return json(200, { batch_header: { payout_batch_id: 'BATCH7', batch_status: 'PENDING', sender_batch_header: { sender_batch_id: u.pathname.endsWith('BATCH7') ? 'payout-RoomP-7' : 'x' } } })
    }
    await expect(createPayout({ roomId: 'RoomP', attempt: 7, receiverEmail: 'sb-test@personal.example.com', amountCents: 100, note: 'Payout' })).resolves.toMatchObject({ payoutBatchId: 'BATCH7', recovered: true })
    // A linked batch that belongs to another sender_batch_id is never adopted.
    await expect(createPayout({ roomId: 'RoomP', attempt: 8, receiverEmail: 'sb-test@personal.example.com', amountCents: 100, note: 'Payout' })).rejects.toMatchObject({ httpStatus: 400 })
  })

  it('validates inputs before calling PayPal', async () => {
    handler = () => json(500)
    await expect(createPayout({ roomId: 'RoomP', attempt: 1, receiverEmail: 'nope', amountCents: 100, note: '' })).rejects.toMatchObject({ name: 'INVALID_ARGUMENT' })
    await expect(createPayout({ roomId: 'RoomP', attempt: 1, receiverEmail: 'a@b.co', amountCents: 0, note: '' })).rejects.toMatchObject({ name: 'INVALID_ARGUMENT' })
    expect(calls).toHaveLength(0)
  })
})
