// One small DB interface over node-postgres (DATABASE_URL) or PGlite (local/test).
// Use $1..$n placeholders. Rows come back as plain objects with snake_case keys.
import { readFile } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
}

export interface Db extends Queryable {
  /** Runs fn in a transaction. Use `SELECT ... FOR UPDATE` inside for row locks. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>
  close(): Promise<void>
  kind: 'pg' | 'pglite'
}

const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql')

async function loadSchema(): Promise<string> {
  // In dist builds schema.sql is copied next to db.js; fall back to the source tree.
  try {
    return await readFile(schemaPath, 'utf8')
  } catch {
    return readFile(path.resolve(process.cwd(), 'src/server/db/schema.sql'), 'utf8')
  }
}

export async function openDb(opts: { databaseUrl: string | null; pgliteDir?: string | 'memory' }): Promise<Db> {
  const schema = await loadSchema()
  if (opts.databaseUrl) {
    const pg = await import('pg')
    const pool = new pg.default.Pool({
      connectionString: opts.databaseUrl,
      max: 8,
      ssl: /sslmode=require|neon\.tech|render\.com/.test(opts.databaseUrl) ? { rejectUnauthorized: false } : undefined,
    })
    await pool.query(schema)
    const db: Db = {
      kind: 'pg',
      async query(sql, params) {
        const r = await pool.query(sql, params as unknown[])
        return r.rows
      },
      async tx(fn) {
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          const out = await fn({
            async query(sql, params) {
              const r = await client.query(sql, params as unknown[])
              return r.rows
            },
          })
          await client.query('COMMIT')
          return out
        } catch (e) {
          await client.query('ROLLBACK').catch(() => {})
          throw e
        } finally {
          client.release()
        }
      },
      async close() {
        await pool.end()
      },
    }
    return db
  }

  const { PGlite } = await import('@electric-sql/pglite')
  let dataDir: string | undefined
  if (opts.pgliteDir !== 'memory') {
    dataDir = opts.pgliteDir ?? path.resolve(process.cwd(), '.data/pglite')
    await mkdir(dataDir, { recursive: true })
  }
  const lite = dataDir ? new PGlite(dataDir) : new PGlite()
  await lite.exec(schema)
  // PGlite is single-connection: serialize transactions so they don't interleave.
  let chain: Promise<unknown> = Promise.resolve()
  const db: Db = {
    kind: 'pglite',
    async query(sql, params) {
      const r = await lite.query(sql, params as unknown[])
      return r.rows as never[]
    },
    tx(fn) {
      const run = chain.then(() =>
        lite.transaction(async (t) =>
          fn({
            async query(sql, params) {
              const r = await t.query(sql, params as unknown[])
              return r.rows as never[]
            },
          }),
        ),
      )
      chain = run.catch(() => {})
      return run
    },
    async close() {
      await lite.close()
    },
  }
  return db
}

let current: Db | null = null

export function setDb(db: Db): void {
  current = db
}

export function db(): Db {
  if (!current) throw new Error('DB not opened yet; call openDb() and setDb() at boot')
  return current
}
