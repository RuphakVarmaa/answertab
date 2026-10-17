// Webhooks: signature verification (PayPal's verify API, raw body spliced in byte-for-byte) and registration
// (list, then PATCH event_types; create only when no webhook has this URL). Webhooks only reconcile.
import { config } from '../config.js'
import { restCall } from './client.js'
import { isPayPalError, localError, parseJsonSafe } from './errors.js'
import { createLimiter } from './limiter.js'

export const WEBHOOK_EVENT_TYPES = [
  'CHECKOUT.ORDER.APPROVED',
  'PAYMENT.AUTHORIZATION.CREATED',
  'PAYMENT.AUTHORIZATION.VOIDED',
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.PENDING',
  'PAYMENT.CAPTURE.DENIED',
  'PAYMENT.CAPTURE.REFUNDED',
  'PAYMENT.PAYOUTSBATCH.SUCCESS',
  'PAYMENT.PAYOUTSBATCH.DENIED',
  'PAYMENT.PAYOUTS-ITEM.UNCLAIMED',
  'CUSTOMER.DISPUTE.CREATED',
  'CUSTOMER.DISPUTE.UPDATED',
  'CUSTOMER.DISPUTE.RESOLVED',
  'INVOICING.INVOICE.PAID',
] as const

type HeaderBag = Record<string, string | string[] | undefined>

function h(headers: HeaderBag, name: string): string | null {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name) {
      const s = Array.isArray(v) ? v[0] : v
      return typeof s === 'string' && s !== '' ? s : null
    }
  }
  return null
}

/**
 * The verify-webhook-signature request body with the event spliced in verbatim. Re-serializing the event
 * can change bytes (key order, unicode escapes, number formats) and make a valid signature fail.
 */
export function buildVerifyBody(headers: HeaderBag, rawBody: string, webhookId: string): string | null {
  const fields = {
    auth_algo: h(headers, 'paypal-auth-algo'),
    cert_url: h(headers, 'paypal-cert-url'),
    transmission_id: h(headers, 'paypal-transmission-id'),
    transmission_sig: h(headers, 'paypal-transmission-sig'),
    transmission_time: h(headers, 'paypal-transmission-time'),
  }
  if (Object.values(fields).some((v) => v === null)) return null
  const trimmed = rawBody.trim()
  if (!trimmed.startsWith('{') || parseJsonSafe(trimmed) === null) return null
  const head = Object.entries({ ...fields, webhook_id: webhookId })
    .map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`)
    .join(',')
  return `{${head},"webhook_event":${trimmed}}`
}

let warnedNoWebhookId = false

/** Webhook verification gets its own small limiter, so forged events cannot starve holds, captures and voids. */
export const webhookVerifyLimit = createLimiter(1)
/** Deliveries waiting for a verify slot beyond this are answered 503 (PayPal retries genuine ones). */
export const WEBHOOK_VERIFY_MAX_QUEUE = 8
const CERT_HOSTS = new Set(['api.paypal.com', 'api.sandbox.paypal.com', 'api-m.paypal.com', 'api-m.sandbox.paypal.com'])
/** PayPal's transmission time must be recent (retries are new transmissions with their own time). */
const MAX_TRANSMISSION_AGE_MS = 24 * 3600_000
const MAX_TRANSMISSION_SKEW_MS = 10 * 60_000

/** Cheap local checks before any PayPal call: the cert URL is PayPal's own https host and the time is recent. */
export function plausibleWebhookHeaders(headers: HeaderBag, nowMs = Date.now()): boolean {
  const cert = h(headers, 'paypal-cert-url')
  const time = h(headers, 'paypal-transmission-time')
  if (!cert || !time) return false
  let u: URL
  try {
    u = new URL(cert)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || !CERT_HOSTS.has(u.hostname.toLowerCase()) || (u.port !== '' && u.port !== '443')) return false
  const t = Date.parse(time)
  if (!Number.isFinite(t)) return false
  return t <= nowMs + MAX_TRANSMISSION_SKEW_MS && nowMs - t <= MAX_TRANSMISSION_AGE_MS
}

export type WebhookVerification = 'verified' | 'rejected' | 'unknown'

/**
 * 'verified' only when PayPal says SUCCESS. 'rejected' for missing or implausible headers, no PAYPAL_WEBHOOK_ID,
 * a 4xx or FAILURE. 'unknown' when the verify call itself failed (timeout, 5xx, no status, verify queue full):
 * the route answers 503 so PayPal delivers the event again.
 */
export async function verifyWebhookResult(headers: HeaderBag, rawBody: string | Buffer): Promise<WebhookVerification> {
  const webhookId = config().paypal.webhookId
  if (!webhookId) {
    if (!warnedNoWebhookId) console.warn('[paypal-webhooks] PAYPAL_WEBHOOK_ID is not set; rejecting webhook events')
    warnedNoWebhookId = true
    return 'rejected'
  }
  const raw = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8')
  if (!plausibleWebhookHeaders(headers)) return 'rejected'
  const body = buildVerifyBody(headers, raw, webhookId)
  if (!body) return 'rejected'
  if (webhookVerifyLimit.queued() >= WEBHOOK_VERIFY_MAX_QUEUE) return 'unknown'
  const event = parseJsonSafe(raw) as { id?: string; event_type?: string } | null
  try {
    const res = await restCall<{ verification_status?: string }>(
      {
        op: 'webhooks.verify', method: 'POST', endpoint: '/v1/notifications/verify-webhook-signature',
        resource: (b) => ({ id: event?.id ?? null, status: b?.verification_status ?? null }),
        requestExtra: { event_id: event?.id ?? null, event_type: event?.event_type ?? null },
        limit: webhookVerifyLimit,
        omitRequestBody: true,
      },
      { path: '/v1/notifications/verify-webhook-signature', rawBody: body },
    )
    const status = res.body?.verification_status
    if (status === 'SUCCESS') return 'verified'
    return typeof status === 'string' ? 'rejected' : 'unknown'
  } catch (e) {
    // Recorded in the ledger by restCall. Only a definitive 4xx is a rejection.
    const status = isPayPalError(e) ? e.httpStatus : 0
    return status >= 400 && status < 500 ? 'rejected' : 'unknown'
  }
}

/** True only when PayPal says SUCCESS (any doubt is false). */
export async function verifyWebhook(headers: HeaderBag, rawBody: string | Buffer): Promise<boolean> {
  return (await verifyWebhookResult(headers, rawBody)) === 'verified'
}

export interface WebhookInfo {
  id: string
  url: string
  eventTypes: string[]
}

function toInfo(w: any): WebhookInfo {
  return { id: String(w?.id ?? ''), url: String(w?.url ?? ''), eventTypes: Array.isArray(w?.event_types) ? w.event_types.map((e: any) => String(e?.name)) : [] }
}

export async function listWebhooks(): Promise<WebhookInfo[]> {
  const res = await restCall(
    { op: 'webhooks.list', method: 'GET', endpoint: '/v1/notifications/webhooks', resource: (b) => ({ id: null, status: `${b?.webhooks?.length ?? 0} webhooks` }) },
    { path: '/v1/notifications/webhooks' },
  )
  return ((res.body?.webhooks ?? []) as unknown[]).map(toInfo)
}

/** Make sure one webhook points at `url` with our event types. Never creates a second one for the same URL. */
export async function ensureWebhook(url: string): Promise<{ webhookId: string; created: boolean; eventTypes: string[] }> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw localError('INVALID_ARGUMENT', `not a URL: ${url}`)
  }
  if (parsed.protocol !== 'https:') throw localError('INVALID_ARGUMENT', 'PayPal webhooks need a public https URL')
  const eventTypes = WEBHOOK_EVENT_TYPES.map((name) => ({ name }))
  const existing = (await listWebhooks()).find((w) => w.url === url)
  if (existing) {
    const res = await restCall(
      { op: 'webhooks.update', method: 'PATCH', endpoint: `/v1/notifications/webhooks/${existing.id}` },
      { path: `/v1/notifications/webhooks/${encodeURIComponent(existing.id)}`, body: [{ op: 'replace', path: '/event_types', value: eventTypes }] },
    )
    return { webhookId: existing.id, created: false, eventTypes: toInfo(res.body).eventTypes }
  }
  const res = await restCall(
    { op: 'webhooks.create', method: 'POST', endpoint: '/v1/notifications/webhooks' },
    { path: '/v1/notifications/webhooks', body: { url, event_types: eventTypes } },
  )
  const info = toInfo(res.body)
  if (!info.id) throw localError('INVALID_RESPONSE', 'webhook create returned no id')
  return { webhookId: info.id, created: true, eventTypes: info.eventTypes }
}
