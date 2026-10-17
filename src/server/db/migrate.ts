// `npm run migrate`: applies schema.sql (idempotent) to DATABASE_URL or local PGlite.
import { openDb } from './db.js'

const db = await openDb({ databaseUrl: process.env.DATABASE_URL || null })
const rows = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema = 'public'`)
console.log(`schema applied (${db.kind}), ${rows[0]?.n} tables`)
await db.close()
