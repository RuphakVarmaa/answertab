// /api/status: real checks, refreshed every 5 minutes into status_checks (PayPal OAuth, webhook registration,
// merchant balance, Anthropic, LLM budget per pool, last synthetic run). Reads never call out.
import type { BudgetPool, StatusCheck } from '../shared/types.js'
import { formatCents } from '../shared/money.js'
import { aiEnabled, budget } from './ai/index.js'
import { config } from './config.js'
import { db } from './db/db.js'
import { accessToken, getBalances, listWebhooks } from './paypal/index.js'

export const STATUS_EVERY_MS = 5 * 60_000

type Check = Omit<StatusCheck, 'checkedAt'>

function ago(d: Date | string | null): string {
  if (!d) return 'never'
  const s = Math.max(0, Math.round((Date.now() - new Date(d).getTime()) / 1000))
  if (s < 90) return `${s} s ago`
  if (s < 5400) return `${Math.round(s / 60)} min ago`
  return `${Math.round(s / 3600)} h ago`
}

function failure(name: string, e: unknown): Check {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
  return { name, ok: false, detail: msg.slice(0, 200) }
}

async function paypalOauth(): Promise<Check> {
  try {
    await accessToken()
    return { name: 'paypal_oauth', ok: true, detail: 'Sandbox OAuth token issued' }
  } catch (e) {
    return failure('paypal_oauth', e)
  }
}

async function paypalWebhook(): Promise<Check> {
  const id = config().paypal.webhookId
  const [last] = await db().query<{ at: Date | null }>(`SELECT max(received_at) AS at FROM webhook_events WHERE verified`)
  const seen = `last verified event ${ago(last?.at ?? null)}`
  if (!id) return { name: 'paypal_webhook', ok: false, detail: `PAYPAL_WEBHOOK_ID not set: webhooks cannot be verified (${seen})` }
  try {
    const hook = (await listWebhooks()).find((w) => w.id === id)
    if (!hook) return { name: 'paypal_webhook', ok: false, detail: `Webhook ${id} is not registered on this app (${seen})` }
    return { name: 'paypal_webhook', ok: true, detail: `Registered for ${hook.url} with ${hook.eventTypes.length} event types; ${seen}` }
  } catch (e) {
    return failure('paypal_webhook', e)
  }
}

async function paypalBalance(): Promise<Check> {
  try {
    const { balances } = await getBalances()
    const usd = balances.find((b) => b.currency === 'USD') ?? balances.find((b) => b.primary) ?? balances[0]
    if (!usd) return { name: 'paypal_balance', ok: false, detail: 'No balance returned' }
    const avail = usd.availableCents ?? usd.totalCents
    const shown = avail === null ? '?' : `${avail < 0 ? '-' : ''}${formatCents(Math.abs(avail))}`
    return { name: 'paypal_balance', ok: (avail ?? 0) > 0, detail: `Merchant ${usd.currency} available ${shown} (Reporting API, can lag up to 3 h)` }
  } catch (e) {
    return failure('paypal_balance', e)
  }
}

async function anthropic(): Promise<Check> {
  if (!aiEnabled()) return { name: 'anthropic', ok: false, detail: 'No Anthropic key: rooms run in manual-confirm mode with the same span guard' }
  const [last] = await db().query<{ ok: boolean; created_at: Date }>(`SELECT ok, created_at FROM detections WHERE purpose = 'detect' ORDER BY created_at DESC LIMIT 1`)
  if (!last) return { name: 'anthropic', ok: true, detail: 'Key present; no detection yet' }
  return { name: 'anthropic', ok: last.ok, detail: `Key present; last detection ${last.ok ? 'ok' : 'failed'} ${ago(last.created_at)}` }
}

async function budgetCheck(pool: BudgetPool): Promise<Check> {
  try {
    const s = await budget.status(null, pool)
    const left = Math.max(0, s.poolLimitMicros - s.poolSpentMicros)
    const usd = (m: number) => `$${(m / 1_000_000).toFixed(2)}`
    return { name: `llm_budget_${pool}`, ok: left > 0, detail: `${usd(left)} of ${usd(s.poolLimitMicros)} left today (UTC ${s.day})` }
  } catch (e) {
    return failure(`llm_budget_${pool}`, e)
  }
}

/** The scheduled interval (SYNTHETIC_EVERY_MIN, minimum 5), or null when runs are not scheduled. */
function syntheticEveryMs(): number | null {
  const raw = Number(process.env.SYNTHETIC_EVERY_MIN ?? '')
  return Number.isFinite(raw) && raw > 0 ? Math.max(5, raw) * 60_000 : null
}

async function synthetic(): Promise<Check> {
  const [r] = await db().query<{ ok: boolean | null; started_at: Date; finished_at: Date | null; room_id: string | null }>(
    `SELECT ok, started_at, finished_at, room_id FROM synthetic_runs ORDER BY started_at DESC LIMIT 1`,
  )
  if (!r) return { name: 'synthetic_run', ok: false, detail: 'No synthetic run yet' }
  if (r.ok === null) return { name: 'synthetic_run', ok: false, detail: `Run started ${ago(r.started_at)} has not finished` }
  const detail = `Last run ${ago(r.finished_at ?? r.started_at)}: ${r.ok ? 'passed' : 'failed'}${r.room_id ? ` (room ${r.room_id})` : ''}`
  // With a schedule, a pass older than two intervals is stale: the schedule stopped or runs hang.
  const every = syntheticEveryMs()
  const age = Date.now() - new Date(r.finished_at ?? r.started_at).getTime()
  if (r.ok && every !== null && age > 2 * every) return { name: 'synthetic_run', ok: false, detail: `${detail}; stale (scheduled every ${every / 60_000} min)` }
  return { name: 'synthetic_run', ok: r.ok, detail }
}

export interface LastPassedRun {
  id: string
  finishedAt: string | null
  roomId: string | null
  steps: { name: string; paypalId: string | null; status: string | null }[]
  timings: Record<string, number>
}

/**
 * The newest passed synthetic run, for the "sandbox degraded" fallback on the landing page: PayPal IDs and
 * statuses only (synthetic_runs.details never holds tokens or card data; only these fields are copied out).
 */
export async function lastPassedRun(): Promise<LastPassedRun | null> {
  const [r] = await db().query<{ id: string; finished_at: Date | string | null; room_id: string | null; details: unknown }>(
    `SELECT id, finished_at, room_id, details FROM synthetic_runs WHERE ok = true ORDER BY finished_at DESC NULLS LAST LIMIT 1`,
  )
  if (!r) return null
  const d = (r.details ?? {}) as {
    timings?: Record<string, unknown>
    paypal?: {
      tabs?: { fan?: unknown; state?: unknown; authStatus?: unknown; orderId?: unknown; authorizationId?: unknown; captureId?: unknown }[]
      refund?: { refundId?: unknown; state?: unknown } | null
      payout?: { payoutBatchId?: unknown; batchStatus?: unknown; state?: unknown } | null
    }
  }
  const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v.slice(0, 80) : null)
  const steps: LastPassedRun['steps'] = []
  for (const t of Array.isArray(d.paypal?.tabs) ? d.paypal!.tabs! : []) {
    const fan = str(t.fan) ?? 'fan'
    steps.push({ name: `${fan}: hold`, paypalId: str(t.authorizationId), status: str(t.authStatus) })
    if (str(t.captureId)) steps.push({ name: `${fan}: capture`, paypalId: str(t.captureId), status: str(t.state) })
  }
  if (d.paypal?.refund) steps.push({ name: 'contest refund', paypalId: str(d.paypal.refund.refundId), status: str(d.paypal.refund.state) })
  if (d.paypal?.payout) steps.push({ name: 'creator payout', paypalId: str(d.paypal.payout.payoutBatchId), status: str(d.paypal.payout.batchStatus) ?? str(d.paypal.payout.state) })
  const timings: Record<string, number> = {}
  for (const [k, v] of Object.entries(d.timings ?? {})) if (typeof v === 'number' && Number.isFinite(v)) timings[k.slice(0, 40)] = v
  return { id: r.id, finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null, roomId: r.room_id, steps, timings }
}

let refreshing: Promise<StatusCheck[]> | null = null

export function refreshStatus(): Promise<StatusCheck[]> {
  refreshing ??= (async () => {
    const checks = await Promise.all([paypalOauth(), paypalWebhook(), paypalBalance(), anthropic(), budgetCheck('judge'), budgetCheck('public'), synthetic()])
    const at = new Date()
    for (const c of checks) {
      await db().query(
        `INSERT INTO status_checks (name, ok, detail, checked_at) VALUES ($1,$2,$3,$4)
         ON CONFLICT (name) DO UPDATE SET ok = EXCLUDED.ok, detail = EXCLUDED.detail, checked_at = EXCLUDED.checked_at`,
        [c.name, c.ok, c.detail, at],
      )
    }
    return checks.map((c) => ({ ...c, checkedAt: at.toISOString() }))
  })().finally(() => {
    refreshing = null
  })
  return refreshing
}

export async function getStatus(): Promise<StatusCheck[]> {
  const rows = await db().query<{ name: string; ok: boolean; detail: string; checked_at: Date | string }>(`SELECT * FROM status_checks ORDER BY name`)
  if (rows.length === 0 && !config().isTest) refreshStatus().catch(() => {})
  return rows.map((r) => ({ name: r.name, ok: r.ok, detail: r.detail, checkedAt: new Date(r.checked_at).toISOString() }))
}

export function startStatusChecker(everyMs = STATUS_EVERY_MS): () => void {
  const run = () => refreshStatus().catch((e) => console.warn(`[status] refresh failed: ${e instanceof Error ? e.message : String(e)}`))
  const first = setTimeout(run, 2_000)
  const timer = setInterval(run, everyMs)
  return () => {
    clearTimeout(first)
    clearInterval(timer)
  }
}
