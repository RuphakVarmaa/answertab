import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDb, setDb, type Db } from '../src/server/db/db.js'
import { budget, setBudgetTestHooks, utcDay } from '../src/server/ai/budget.js'
import { callClaude, setAiTroubleListener, setAnthropicClientForTests } from '../src/server/ai/anthropic.js'
import { scriptedClient } from '../src/server/ai/fakeClient.js'

let db: Db
let now = new Date('2026-10-16T23:59:00Z')

beforeAll(async () => {
  db = await openDb({ databaseUrl: null, pgliteDir: 'memory' })
  setDb(db)
  setBudgetTestHooks({ now: () => now, limits: { judgeDailyMicros: 10_000, publicDailyMicros: 5_000, roomCapMicros: 4_000 } })
  for (const [id, pool] of [['roomA', 'public'], ['roomB', 'public'], ['roomJ', 'judge']]) {
    await db.query(
      `INSERT INTO rooms (id, creator_token_hash, title, kind, pool, question_price_cents, metoo_price_cents) VALUES ($1,'h','t','demo',$2,600,300)`,
      [id, pool],
    )
  }
})

afterAll(async () => {
  setAnthropicClientForTests(undefined)
  setAiTroubleListener(null)
  await db.close()
})

describe('budget', () => {
  it('enforces the per-room cap', async () => {
    expect(await budget.canSpend('roomA', 'public', 4_000)).toBe(true)
    await budget.record('roomA', 'public', 3_500)
    expect(await budget.canSpend('roomA', 'public', 500)).toBe(true)
    expect(await budget.canSpend('roomA', 'public', 501)).toBe(false)
    const rows = await db.query<{ llm_spent_micros: string }>(`SELECT llm_spent_micros FROM rooms WHERE id='roomA'`)
    expect(Number(rows[0]!.llm_spent_micros)).toBe(3_500)
  })

  it('enforces the daily pool across rooms, separately per pool', async () => {
    await budget.record('roomB', 'public', 1_400) // public pool now 4_900 of 5_000
    expect(await budget.canSpend('roomB', 'public', 200)).toBe(false)
    expect(await budget.canSpend('roomJ', 'judge', 4_000)).toBe(true)
  })

  it('resets the pool on the next UTC day but keeps the room total', async () => {
    expect(utcDay()).toBe('2026-10-16')
    now = new Date('2026-10-17T00:00:01Z')
    expect(utcDay()).toBe('2026-10-17')
    expect(await budget.canSpend('roomB', 'public', 2_000)).toBe(true)
    expect(await budget.canSpend('roomA', 'public', 600)).toBe(false) // room cap is not daily
    const pools = await db.query<{ day: string; spent_micros: string }>(`SELECT to_char(day, 'YYYY-MM-DD') AS day, spent_micros FROM llm_budget WHERE pool='public'`)
    expect(pools.map((r) => [r.day, Number(r.spent_micros)])).toEqual([['2026-10-16', 4900]])
  })

  it('callClaude refuses before calling when the cap is hit and reports budget trouble', async () => {
    const client = scriptedClient([{ text: '{}' }])
    setAnthropicClientForTests(client)
    const troubles: string[] = []
    setAiTroubleListener((e) => troubles.push(`${e.roomId}:${e.reason}`))
    const out = await callClaude({ model: 'claude-haiku-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }, { roomId: 'roomA', purpose: 'detect', estMicros: 1_000, timeoutMs: 1_000 })
    expect(out).toMatchObject({ ok: false, reason: 'budget' })
    expect(client.requests).toHaveLength(0)
    expect(troubles).toEqual(['roomA:budget'])
    const ok = await callClaude({ model: 'claude-haiku-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }, { roomId: 'roomJ', purpose: 'detect', estMicros: 1_000, timeoutMs: 1_000 })
    expect(ok.ok).toBe(true)
    const j = await db.query<{ spent_micros: string }>(`SELECT spent_micros FROM llm_budget WHERE pool='judge' AND day='2026-10-17'`)
    expect(Number(j[0]!.spent_micros)).toBeGreaterThan(0)
  })
})
