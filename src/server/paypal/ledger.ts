// The paypal_calls ledger: one row per PayPal HTTP call, redacted, plus an in-process event feed
// (the API layer turns it into SSE 'ledger.call'). A failed DB write never fails the PayPal call.
import type { LedgerCallView } from '../../shared/types.js'
import { db } from '../db/db.js'
import { newId } from '../ids.js'
import { redact } from './redact.js'

/** Which room/tab a call belongs to. tab_id is resolved from (roomId, fanId) or contestId when not given. */
export interface LedgerContext {
  roomId?: string | null
  fanId?: string | null
  tabId?: string | null
  contestId?: string | null
}

export interface LedgerEntry {
  op: string
  method: string
  endpoint: string
  requestId: string | null
  /** 0 when no HTTP response was received. */
  httpStatus: number
  resourceId?: string | null
  resourceStatus?: string | null
  debugId?: string | null
  latencyMs: number
  ctx?: LedgerContext
  /** Redacted before storage. */
  request?: unknown
  /** Redacted before storage. */
  response?: unknown
}

export interface LedgerEvent {
  roomId: string | null
  call: LedgerCallView
}

export interface LedgerRow {
  id: string
  room_id: string | null
  tab_id: string | null
  op: string
  method: string
  endpoint: string
  request_id: string | null
  http_status: number
  resource_id: string | null
  resource_status: string | null
  debug_id: string | null
  latency_ms: number
  request_redacted: unknown
  response_redacted: unknown
  created_at: string | Date
}

type Listener = (e: LedgerEvent) => void
const listeners = new Set<Listener>()

/** Subscribe to every recorded call. Returns an unsubscribe function. */
export function onLedgerCall(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

let warnedNoDb = false
function warn(msg: string): void {
  console.warn(`[paypal-ledger] ${msg}`)
}

const INSERT = `
INSERT INTO paypal_calls (id, room_id, tab_id, op, method, endpoint, request_id, http_status, resource_id,
  resource_status, debug_id, latency_ms, request_redacted, response_redacted)
VALUES ($1,
  COALESCE($2::text, (SELECT room_id FROM contests WHERE id = $4::text)),
  COALESCE($3::text,
    (SELECT id FROM tabs WHERE room_id = $2::text AND fan_id = $5::text LIMIT 1),
    (SELECT tab_id FROM contests WHERE id = $4::text)),
  $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16::jsonb)
RETURNING room_id, tab_id, created_at`

function toIso(v: string | Date | undefined): string {
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'string') return new Date(v).toISOString()
  return new Date().toISOString()
}

export async function record(e: LedgerEntry): Promise<LedgerCallView> {
  const id = newId('ppc')
  const ctx = e.ctx ?? {}
  const latencyMs = Math.max(0, Math.round(e.latencyMs))
  const reqJson = e.request === undefined ? null : JSON.stringify(redact(e.request))
  const resJson = e.response === undefined ? null : JSON.stringify(redact(e.response))
  let roomId = ctx.roomId ?? null
  let tabId = ctx.tabId ?? null
  let at = new Date().toISOString()

  const params = (room: string | null) => [
    id, room, ctx.tabId ?? null, ctx.contestId ?? null, ctx.fanId ?? null,
    e.op, e.method, e.endpoint, e.requestId, e.httpStatus, e.resourceId ?? null, e.resourceStatus ?? null,
    e.debugId ?? null, latencyMs, reqJson, resJson,
  ]
  try {
    const conn = db()
    let rows: { room_id: string | null; tab_id: string | null; created_at: string | Date }[]
    try {
      rows = await conn.query(INSERT, params(roomId))
    } catch (err) {
      // A call for a room that is not (yet) in the DB still gets a row, just unlinked.
      if ((err as { code?: string }).code !== '23503') throw err
      rows = await conn.query(INSERT, params(null))
    }
    const row = rows[0]
    if (row) {
      roomId = row.room_id
      tabId = row.tab_id
      at = toIso(row.created_at)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/DB not opened/.test(msg)) {
      if (!warnedNoDb) warn('DB not opened; PayPal calls are not being persisted')
      warnedNoDb = true
    } else {
      warn(`write failed for ${e.op}: ${msg.slice(0, 200)}`)
    }
  }

  const call: LedgerCallView = {
    id,
    at,
    op: e.op,
    method: e.method,
    endpoint: e.endpoint,
    requestId: e.requestId,
    httpStatus: e.httpStatus,
    resourceId: e.resourceId ?? null,
    resourceStatus: e.resourceStatus ?? null,
    debugId: e.debugId ?? null,
    latencyMs,
    tabId,
  }
  for (const l of listeners) {
    try {
      l({ roomId, call })
    } catch (err) {
      warn(`listener failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return call
}

export function rowToView(r: LedgerRow): LedgerCallView {
  return {
    id: r.id,
    at: toIso(r.created_at),
    op: r.op,
    method: r.method,
    endpoint: r.endpoint,
    requestId: r.request_id,
    httpStatus: r.http_status,
    resourceId: r.resource_id,
    resourceStatus: r.resource_status,
    debugId: r.debug_id,
    latencyMs: r.latency_ms,
    tabId: r.tab_id,
  }
}

export async function getLedgerCall(id: string): Promise<LedgerRow | null> {
  const rows = await db().query<LedgerRow>(`SELECT * FROM paypal_calls WHERE id = $1`, [id])
  return rows[0] ?? null
}

/** Oldest first, for the console's ledger panel. */
export async function listLedgerCalls(roomId: string, limit = 500): Promise<LedgerCallView[]> {
  const rows = await db().query<LedgerRow>(
    `SELECT * FROM (SELECT * FROM paypal_calls WHERE room_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2) t ORDER BY created_at, id`,
    [roomId, limit],
  )
  return rows.map(rowToView)
}

export const ledger = { record, onLedgerCall, getLedgerCall, listLedgerCalls }
