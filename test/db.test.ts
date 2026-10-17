import { describe, expect, it } from 'vitest'
import { openDb } from '../src/server/db/db.js'

describe('db', () => {
  it('applies the schema on PGlite and runs transactions', async () => {
    const db = await openDb({ databaseUrl: null, pgliteDir: 'memory' })
    const tables = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1`,
    )
    expect(tables.map((t) => t.table_name)).toContain('paypal_calls')
    await db.tx(async (q) => {
      await q.query(`INSERT INTO llm_budget(pool, day, spent_micros) VALUES ('judge', current_date, 5)`)
    })
    await expect(
      db.tx(async (q) => {
        await q.query(`INSERT INTO llm_budget(pool, day, spent_micros) VALUES ('public', current_date, 1)`)
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')
    const rows = await db.query<{ pool: string }>(`SELECT pool FROM llm_budget`)
    expect(rows.map((r) => r.pool)).toEqual(['judge'])
    await db.close()
  })
})
