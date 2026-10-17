import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { openDb, setDb, type Db } from '../src/server/db/db.js'
import { getLedgerCall, listLedgerCalls, onLedgerCall, record, type LedgerEvent } from '../src/server/paypal/ledger.js'
import { createLimiter } from '../src/server/paypal/limiter.js'

let db: Db

beforeAll(async () => {
  db = await openDb({ databaseUrl: null, pgliteDir: 'memory' })
  setDb(db)
  await db.query(`INSERT INTO rooms (id, creator_token_hash, title, kind, pool, question_price_cents, metoo_price_cents) VALUES ('RoomA', 'h', 'T', 'demo', 'judge', 300, 100)`)
  await db.query(`INSERT INTO fans (id, room_id, display_name, fan_token) VALUES ('fan_1', 'RoomA', 'Ann', 'tok1')`)
  await db.query(`INSERT INTO tabs (id, room_id, fan_id, ceiling_cents, funding) VALUES ('tab_1', 'RoomA', 'fan_1', 2000, 'bot_card')`)
})
afterAll(async () => {
  await db.close()
})

const base = { method: 'POST', endpoint: '/v2/checkout/orders', requestId: 'order-RoomA-fan_1', httpStatus: 201, latencyMs: 12.6 }

describe('ledger', () => {
  it('writes a redacted row, resolves the tab, and notifies listeners', async () => {
    const events: LedgerEvent[] = []
    const off = onLedgerCall((e) => events.push(e))
    const call = await record({
      ...base,
      op: 'orders.create',
      resourceId: 'ORDER1',
      resourceStatus: 'COMPLETED; auth=CREATED',
      debugId: 'dbg1',
      ctx: { roomId: 'RoomA', fanId: 'fan_1' },
      request: { headers: { 'paypal-request-id': 'order-RoomA-fan_1' }, body: { payment_source: { card: { number: '4111111111111111', security_code: '123', expiry: '2030-12' } } } },
      response: { id: 'ORDER1', payer: { email_address: 'ann@example.com' } },
    })
    off()
    expect(call).toMatchObject({ op: 'orders.create', tabId: 'tab_1', latencyMs: 13, httpStatus: 201, resourceId: 'ORDER1' })
    expect(events).toHaveLength(1)
    expect(events[0]!.roomId).toBe('RoomA')
    expect(events[0]!.call.id).toBe(call.id)

    const row = await getLedgerCall(call.id)
    const stored = JSON.stringify(row)
    expect(stored).not.toContain('4111111111111111')
    expect(stored).not.toContain('2030-12')
    expect(stored).not.toContain('ann@example.com')
    expect(row!.room_id).toBe('RoomA')
    expect((await listLedgerCalls('RoomA')).map((c) => c.id)).toContain(call.id)
  })

  it('still records a call for a room that is not in the DB (unlinked)', async () => {
    const call = await record({ ...base, op: 'orders.create', ctx: { roomId: 'NoSuchRoom', fanId: 'x' } })
    const row = await getLedgerCall(call.id)
    expect(row).not.toBeNull()
    expect(row!.room_id).toBeNull()
  })

  it('never throws when the DB write fails, and still emits the event', async () => {
    const broken: Db = {
      kind: 'pglite',
      query: async () => {
        throw new Error('disk full')
      },
      tx: async () => {
        throw new Error('disk full')
      },
      close: async () => {},
    }
    setDb(broken)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const seen: string[] = []
    const off = onLedgerCall((e) => seen.push(e.call.op))
    try {
      const call = await record({ ...base, op: 'payments.capture', ctx: { roomId: 'RoomA' } })
      expect(call.op).toBe('payments.capture')
      expect(seen).toEqual(['payments.capture'])
      expect(warn).toHaveBeenCalled()
    } finally {
      off()
      warn.mockRestore()
      setDb(db)
    }
  })

  it('a throwing listener does not break recording', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const off = onLedgerCall(() => {
      throw new Error('boom')
    })
    await expect(record({ ...base, op: 'payments.void' })).resolves.toMatchObject({ op: 'payments.void' })
    off()
    warn.mockRestore()
  })
})

describe('limiter', () => {
  it('keeps at most 4 calls in flight and finishes all of them in order', async () => {
    const limit = createLimiter(4)
    let active = 0
    let peak = 0
    const started: number[] = []
    const jobs = Array.from({ length: 12 }, (_, i) =>
      limit(async () => {
        started.push(i)
        active++
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 5 + (i % 3)))
        active--
        return i
      }),
    )
    expect(await Promise.all(jobs)).toEqual(Array.from({ length: 12 }, (_, i) => i))
    expect(peak).toBe(4)
    expect(started).toEqual(Array.from({ length: 12 }, (_, i) => i))
    expect(limit.inFlight()).toBe(0)
  })

  it('releases the slot when a job throws', async () => {
    const limit = createLimiter(1)
    await expect(limit(async () => Promise.reject(new Error('x')))).rejects.toThrow('x')
    await expect(limit(async () => 'ok')).resolves.toBe('ok')
  })
})
