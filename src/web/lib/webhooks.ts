// Verified PayPal webhook events as the console and receipts show them. Webhooks only reconcile: every
// field here is optional, nothing waits on one, and a missing or null field hides the UI entirely.
import type { ContestView, TabView, WebhookEventView } from '../../shared/types.js'
import { timeAgo } from './format.js'

/** Webhook confirmation times (ISO, or null until a verified event arrives); optional so older bodies still type. */
export type TabWebhookIn = TabView & { captureWebhookAt?: string | null }
export type ContestWebhookIn = ContestView & { refundWebhookAt?: string | null }

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

/**
 * The console `webhooks` field, cleaned: null when the server does not send it (hide the list), else
 * the verified, well-formed events, newest first.
 */
export function normalizeWebhooks(raw: unknown): WebhookEventView[] | null {
  if (!Array.isArray(raw)) return null
  const out: WebhookEventView[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const id = str(o.id)
    const eventType = str(o.eventType)
    const receivedAt = str(o.receivedAt)
    if (!id || !eventType || !receivedAt || o.verified !== true) continue
    out.push({ id, eventType, resourceId: str(o.resourceId), receivedAt, verified: true })
  }
  return out.sort((a, b) => (Date.parse(b.receivedAt) || 0) - (Date.parse(a.receivedAt) || 0))
}

/** "12 s ago" under a minute (the badge usually lands seconds after settle), else timeAgo's wording. */
export function webhookAgo(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return 'unknown'
  const s = Math.round((now - t) / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s} s ago`
  return timeAgo(iso, now)
}

/** Badge text, or null to render nothing (field absent, null or not a date). */
export function webhookBadgeLabel(at: string | null | undefined, now: number = Date.now()): string | null {
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return null
  return `Confirmed by PayPal webhook, ${webhookAgo(at, now)}`
}

