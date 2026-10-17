// LLM spend caps: a daily pool (judge | public, per UTC day, table llm_budget) and a per-room cap
// (rooms.llm_spent_micros). callClaude reserves the call's worst-case cost first with conditional UPDATEs (so
// concurrent calls cannot all pass the same check), then corrects the reservation to the real cost.
// canSpend is a read-only pre-check; record adds spend directly (tests, tools).
import type { BudgetPool } from '../../shared/types.js'
import { config } from '../config.js'
import { db, type Queryable } from '../db/db.js'

export interface BudgetLimits {
  judgeDailyMicros: number
  publicDailyMicros: number
  roomCapMicros: number
}

export interface BudgetStatus {
  day: string
  poolSpentMicros: number
  poolLimitMicros: number
  roomSpentMicros: number | null
  roomCapMicros: number
}

let nowFn: () => Date = () => new Date()
let limitsOverride: BudgetLimits | null = null

/** Tests only. */
export function setBudgetTestHooks(p: { now?: () => Date; limits?: BudgetLimits | null }): void {
  if (p.now) nowFn = p.now
  if (p.limits !== undefined) limitsOverride = p.limits
}

function limits(): BudgetLimits {
  return limitsOverride ?? config().budgets
}

export function utcDay(d: Date = nowFn()): string {
  return d.toISOString().slice(0, 10)
}

function poolLimit(pool: BudgetPool): number {
  const l = limits()
  return pool === 'judge' ? l.judgeDailyMicros : l.publicDailyMicros
}

async function poolSpent(q: Queryable, pool: BudgetPool, day: string): Promise<number> {
  const rows = await q.query<{ spent_micros: string | number }>(
    `SELECT spent_micros FROM llm_budget WHERE pool = $1 AND day = $2::date`,
    [pool, day],
  )
  return Number(rows[0]?.spent_micros ?? 0)
}

async function roomSpent(q: Queryable, roomId: string): Promise<number | null> {
  const rows = await q.query<{ llm_spent_micros: string | number }>(`SELECT llm_spent_micros FROM rooms WHERE id = $1`, [roomId])
  return rows[0] ? Number(rows[0].llm_spent_micros) : null
}

export async function status(roomId: string | null, pool: BudgetPool): Promise<BudgetStatus> {
  const q = db()
  const day = utcDay()
  return {
    day,
    poolSpentMicros: await poolSpent(q, pool, day),
    poolLimitMicros: poolLimit(pool),
    roomSpentMicros: roomId ? await roomSpent(q, roomId) : null,
    roomCapMicros: limits().roomCapMicros,
  }
}

/** True when both the pool (today, UTC) and the room have room for `estMicros` more. */
export async function canSpend(roomId: string | null, pool: BudgetPool, estMicros: number): Promise<boolean> {
  const est = Math.max(0, Math.ceil(estMicros))
  const s = await status(roomId, pool)
  if (s.poolSpentMicros + est > s.poolLimitMicros) return false
  if (roomId && s.roomSpentMicros !== null && s.roomSpentMicros + est > s.roomCapMicros) return false
  return true
}

/** Adds real spend to today's pool row and to the room. */
export async function record(roomId: string | null, pool: BudgetPool, micros: number): Promise<void> {
  const m = Math.max(0, Math.ceil(micros))
  if (m === 0) return
  const day = utcDay()
  await db().tx(async (q) => {
    await q.query(
      `INSERT INTO llm_budget (pool, day, spent_micros) VALUES ($1, $2::date, $3)
       ON CONFLICT (pool, day) DO UPDATE SET spent_micros = llm_budget.spent_micros + EXCLUDED.spent_micros`,
      [pool, day, m],
    )
    if (roomId) {
      await q.query(`UPDATE rooms SET llm_spent_micros = llm_spent_micros + $2 WHERE id = $1`, [roomId, m])
    }
  })
}

const OVER_CAP = Symbol('over cap')

export interface Reservation {
  roomId: string | null
  pool: BudgetPool
  day: string
  micros: number
}

/**
 * Atomically adds `estMicros` to today's pool and to the room, only if both stay within their caps.
 * Returns null (nothing reserved) when either cap would be passed.
 */
export async function reserve(roomId: string | null, pool: BudgetPool, estMicros: number): Promise<Reservation | null> {
  const m = Math.max(0, Math.ceil(estMicros))
  const day = utcDay()
  const l = limits()
  const poolCap = poolLimit(pool)
  try {
    await db().tx(async (q) => {
      const p = await q.query<{ spent_micros: string | number }>(
        `INSERT INTO llm_budget (pool, day, spent_micros) SELECT $1, $2::date, $3::bigint WHERE $3::bigint <= $4::bigint
         ON CONFLICT (pool, day) DO UPDATE SET spent_micros = llm_budget.spent_micros + EXCLUDED.spent_micros
           WHERE llm_budget.spent_micros + EXCLUDED.spent_micros <= $4::bigint
         RETURNING spent_micros`,
        [pool, day, m, poolCap],
      )
      if (p.length === 0) throw OVER_CAP
      if (roomId) {
        const r = await q.query<{ id: string }>(
          `UPDATE rooms SET llm_spent_micros = llm_spent_micros + $2::bigint WHERE id = $1 AND llm_spent_micros + $2::bigint <= $3::bigint RETURNING id`,
          [roomId, m, l.roomCapMicros],
        )
        if (r.length === 0) {
          const exists = await q.query(`SELECT 1 FROM rooms WHERE id = $1`, [roomId])
          if (exists.length > 0) throw OVER_CAP
        }
      }
    })
  } catch (e) {
    if (e === OVER_CAP) return null
    throw e
  }
  return { roomId, pool, day, micros: m }
}

/** Replaces a reservation with the real cost (which can be lower or higher). Never below zero. */
export async function settleReservation(r: Reservation, actualMicros: number): Promise<void> {
  const delta = Math.max(0, Math.ceil(actualMicros)) - r.micros
  if (delta === 0) return
  await db().tx(async (q) => {
    await q.query(`UPDATE llm_budget SET spent_micros = GREATEST(0, spent_micros + $3::bigint) WHERE pool = $1 AND day = $2::date`, [r.pool, r.day, delta])
    if (r.roomId) await q.query(`UPDATE rooms SET llm_spent_micros = GREATEST(0, llm_spent_micros + $2::bigint) WHERE id = $1`, [r.roomId, delta])
  })
}

export const budget = { canSpend, record, status, reserve, settleReservation }
