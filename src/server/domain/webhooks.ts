// PayPal webhooks: verify on the raw body, store (deduplicated by event id), answer 200, then reconcile.
// Unverified events are stored (id and type only) with verified=false and never acted on. When PayPal's verify
// call itself fails, the route answers 503 so PayPal delivers again. The UI never waits on webhooks.
import { db } from '../db/db.js'
import { parseCapture, parseRefund, verifyWebhookResult } from '../paypal/index.js'
import { nowDate } from './clock.js'
import { emitContest } from './contests.js'
import { DomainError, badRequest } from './errors.js'
import { syncDispute } from './disputes.js'
import { payoutWebhook } from './payouts.js'
import type { TabRow } from './rows.js'
import { COMPLETED_CAPTURE, recordCapture, recordVoid } from './settle.js'
import { emitTab } from './views.js'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

/** Payer details are not needed to reconcile; drop them before storing. */
const DROP = new Set(['payer', 'payment_source', 'shipping', 'email_address', 'phone', 'address', 'name', 'buyer', 'payer_info'])
export function scrub(v: unknown, depth = 0): unknown {
  if (depth > 12) return null
  if (Array.isArray(v)) return v.map((x) => scrub(x, depth + 1))
  if (!isObj(v)) return v
  const out: Obj = {}
  for (const [k, x] of Object.entries(v)) if (!DROP.has(k)) out[k] = scrub(x, depth + 1)
  return out
}

const pending = new Set<Promise<void>>()

/** Tests: wait for reconciliation of received events. */
export async function webhooksIdle(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending])
}

export interface WebhookReceipt {
  id: string
  verified: boolean
  duplicate: boolean
}

export async function receiveWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string): Promise<WebhookReceipt> {
  let event: Obj | null = null
  try {
    const parsed: unknown = JSON.parse(rawBody)
    event = isObj(parsed) ? parsed : null
  } catch {
    event = null
  }
  const id = str(event?.id)
  const type = str(event?.event_type)
  if (!event || !id || !type || id.length > 128) throw badRequest('bad_event', 'Not a PayPal webhook event.')
  const [seen] = await db().query<{ verified: boolean }>(`SELECT verified FROM webhook_events WHERE id = $1`, [id])
  if (seen?.verified) return { id, verified: true, duplicate: true }
  const verification = await verifyWebhookResult(headers, rawBody)
  if (verification === 'unknown') throw new DomainError(503, 'verify_unavailable', 'Could not verify the event with PayPal right now; deliver it again.')
  const verified = verification === 'verified'
  const resource = isObj(event.resource) ? event.resource : {}
  const resourceId = str(resource.id) ?? str(resource.dispute_id) ?? str((resource.batch_header as Obj | undefined)?.payout_batch_id) ?? null
  // Unverified bodies are untrusted and can be large: keep only the id and type for the audit trail.
  const payload = JSON.stringify(verified ? scrub(event) : { id, event_type: type })
  const inserted = await db().query<{ id: string }>(
    `INSERT INTO webhook_events (id, event_type, resource_id, verified, payload) VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (id) DO NOTHING RETURNING id`,
    [id, type, verified ? resourceId : null, verified, payload],
  )
  if (inserted.length === 0) {
    // Seen before. Act only if this delivery verifies and the stored one did not (a retried event).
    const upgraded = verified
      ? await db().query<{ id: string }>(
          `UPDATE webhook_events SET verified = true, event_type = $2, resource_id = $3, payload = $4::jsonb WHERE id = $1 AND verified = false RETURNING id`,
          [id, type, resourceId, payload],
        )
      : []
    if (upgraded.length === 0) return { id, verified, duplicate: true }
  }
  if (verified) {
    const p = processEvent(id, type, resource)
    pending.add(p)
    p.finally(() => pending.delete(p)).catch(() => {})
  }
  return { id, verified, duplicate: false }
}

async function processEvent(id: string, type: string, resource: Obj): Promise<void> {
  let note: string | null = null
  try {
    note = await reconcile(type, resource)
    await db().query(`UPDATE webhook_events SET processed_at = now(), error = $2 WHERE id = $1`, [id, note])
  } catch (e) {
    await db().query(`UPDATE webhook_events SET processed_at = now(), error = $2 WHERE id = $1`, [id, (e instanceof Error ? e.message : String(e)).slice(0, 300)]).catch(() => {})
  }
}

/** Returns a note when nothing was changed (stored in webhook_events.error for the audit trail). */
export async function reconcile(type: string, resource: Obj): Promise<string | null> {
  if (type.startsWith('PAYMENT.CAPTURE.') && type !== 'PAYMENT.CAPTURE.REFUNDED') return onCapture(resource)
  if (type === 'PAYMENT.CAPTURE.REFUNDED') return onRefund(resource)
  if (type === 'PAYMENT.AUTHORIZATION.VOIDED') return onVoided(resource)
  if (type.startsWith('PAYMENT.PAYOUTSBATCH.')) {
    const h = isObj(resource.batch_header) ? resource.batch_header : {}
    const batchId = str(h.payout_batch_id)
    if (!batchId) return 'no payout_batch_id'
    return (await payoutWebhook({ payoutBatchId: batchId, batchStatus: str(h.batch_status) })) ? null : 'no matching payout'
  }
  if (type.startsWith('PAYMENT.PAYOUTS-ITEM.')) {
    const batchId = str(resource.payout_batch_id)
    if (!batchId) return 'no payout_batch_id'
    return (await payoutWebhook({ payoutBatchId: batchId, itemStatus: str(resource.transaction_status) })) ? null : 'no matching payout'
  }
  if (type.startsWith('CUSTOMER.DISPUTE.')) {
    const disputeId = str(resource.dispute_id) ?? str(resource.id)
    if (!disputeId) return 'no dispute_id'
    return (await syncDispute(disputeId)) ? null : 'dispute stored; no matching tab'
  }
  return `ignored ${type}`
}

async function onCapture(resource: Obj): Promise<string | null> {
  const c = parseCapture(resource)
  if (!c.captureId) return 'no capture id'
  const [tab] = await db().query<TabRow>(
    `SELECT * FROM tabs WHERE capture_id = $1 OR ($2::text IS NOT NULL AND authorization_id = $2::text) ORDER BY (capture_id = $1) DESC LIMIT 1`,
    [c.captureId, c.authorizationId],
  )
  if (!tab) return 'no matching tab'
  if (tab.capture_id && tab.capture_id !== c.captureId) return 'tab has a different capture'
  // Only tabs we were settling (or settled) are touched; a capture of a held tab we did not make is not ours to book.
  if (tab.state !== 'settling' && tab.state !== 'captured') return `tab is ${tab.state}`
  const upToDate = tab.capture_id === c.captureId && tab.capture_status === c.status && tab.net_cents !== null
  if (!upToDate) await recordCapture(tab, c)
  // Badge only: the first verified event that reports this capture completed. Settlement never waits on it.
  if (COMPLETED_CAPTURE.includes(c.status)) {
    const marked = await db().query<{ id: string }>(
      `UPDATE tabs SET capture_webhook_at = $2 WHERE id = $1 AND capture_id = $3 AND capture_webhook_at IS NULL RETURNING id`,
      [tab.id, nowDate(), c.captureId],
    )
    if (marked.length > 0) await emitTab(tab.id)
  }
  return upToDate ? 'already up to date' : null
}

async function onRefund(resource: Obj): Promise<string | null> {
  const r = parseRefund(resource)
  if (!r.refundId) return 'no refund id'
  const rows = await db().query<{ id: string }>(`SELECT id FROM contests WHERE refund_id = $1`, [r.refundId])
  if (rows.length === 0) return 'refund not issued by a contest'
  if (r.status === 'COMPLETED') {
    const marked = await db().query<{ id: string }>(
      `UPDATE contests SET refund_webhook_at = $2 WHERE refund_id = $1 AND refund_webhook_at IS NULL RETURNING id`,
      [r.refundId, nowDate()],
    )
    for (const m of marked) await emitContest(m.id)
  }
  return null
}

/**
 * Verified events about this room's PayPal resources (captures and authorizations of its tabs, contest refunds,
 * payout batches and items, disputes), newest first. Read-only: the console lists them; nothing waits on them.
 */
async function onVoided(resource: Obj): Promise<string | null> {
  const authId = str(resource.id)
  if (!authId) return 'no authorization id'
  const [tab] = await db().query<TabRow>(`SELECT * FROM tabs WHERE authorization_id = $1`, [authId])
  if (!tab) return 'no matching tab'
  if (tab.state === 'voided') return 'already voided'
  if (tab.capture_id || (tab.state !== 'held' && tab.state !== 'settling')) return `tab is ${tab.state}`
  await recordVoid(tab)
  return null
}
