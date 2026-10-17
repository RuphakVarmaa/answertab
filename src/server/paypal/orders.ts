// Orders v2: AUTHORIZE orders (the fan's tab hold), authorize after approval, and reads.
// Tab status always comes from purchase_units[0].payments.authorizations[0].status, never the order status:
// a processor decline is HTTP 201 with the order COMPLETED and the authorization DENIED.
import {
  CheckoutPaymentIntent,
  OrderApplicationContextShippingPreference,
  OrderApplicationContextUserAction,
  PaypalExperienceUserAction,
  PaypalWalletContextShippingPreference,
} from '@paypal/paypal-server-sdk'
import type { OrderRequest } from '@paypal/paypal-server-sdk'
import type { AuthStatus, Funding } from '../../shared/types.js'
import { assertCents, formatCents, toAmount } from '../../shared/money.js'
import { PREFER_REPRESENTATION, sdkCall } from './client.js'
import { localError } from './errors.js'
import type { LedgerContext } from './ledger.js'
import { redact } from './redact.js'
import { authRequestId, customId, invoiceId, orderRequestId } from './requestIds.js'
import { TEST_CARDS, type TestCard } from './testCards.js'
import { toolkitCall } from './toolkit.js'

export const BRAND_NAME = 'AnswerTab'
export const SOFT_DESCRIPTOR = 'AnswerTab'
const AUTH_STATUSES: readonly AuthStatus[] = ['CREATED', 'CAPTURED', 'DENIED', 'PARTIALLY_CAPTURED', 'VOIDED', 'EXPIRED', 'PENDING']

export interface ProcessorResponse {
  responseCode: string | null
  avsCode: string | null
  cvvCode: string | null
}

export interface ParsedOrder {
  orderId: string
  status: string
  authorizationId?: string
  authStatus?: AuthStatus
  expiresAt?: string
  processorResponse?: ProcessorResponse
  /** Set when the authorization is DENIED. */
  declineReason?: string
  /** Buyer approval link for wallet orders (rel payer-action or approve). */
  approveUrl?: string
  captureIds: string[]
}

export function asAuthStatus(s: unknown): AuthStatus | undefined {
  return typeof s === 'string' && (AUTH_STATUSES as readonly string[]).includes(s) ? (s as AuthStatus) : undefined
}

export function holdDescription(ceilingCents: number): string {
  return `Hold up to ${formatCents(ceilingCents)}. Charged only for questions answered on stream.`.slice(0, 127)
}

/** Request body for an AUTHORIZE order (SDK camelCase model). Exported for tests. */
export function buildAuthorizeOrder(p: { roomId: string; fanId: string; ceilingCents: number; funding: Funding; botCard?: TestCard }): OrderRequest {
  assertCents(p.ceilingCents, 'ceilingCents')
  if (p.ceilingCents <= 0) throw localError('INVALID_ARGUMENT', 'ceilingCents must be > 0')
  const body: OrderRequest = {
    intent: CheckoutPaymentIntent.Authorize,
    purchaseUnits: [
      {
        amount: { currencyCode: 'USD', value: toAmount(p.ceilingCents) },
        description: holdDescription(p.ceilingCents),
        customId: customId(p.roomId, p.fanId),
        invoiceId: invoiceId(p.roomId, p.fanId),
        softDescriptor: SOFT_DESCRIPTOR,
      },
    ],
  }
  if (p.funding === 'paypal') {
    body.paymentSource = {
      paypal: {
        experienceContext: {
          brandName: BRAND_NAME,
          shippingPreference: PaypalWalletContextShippingPreference.NoShipping,
          userAction: PaypalExperienceUserAction.Continue,
        },
      },
    }
  } else if (p.funding === 'card') {
    // Card fields attach the card later (confirm-payment-source), and payment_source.card.experience_context has
    // no brand/shipping/user-action fields, so these go in application_context for card orders.
    body.applicationContext = {
      brandName: BRAND_NAME,
      shippingPreference: OrderApplicationContextShippingPreference.NoShipping,
      userAction: OrderApplicationContextUserAction.Continue,
    }
  } else {
    const card = p.botCard ?? TEST_CARDS[0]!
    body.paymentSource = {
      card: {
        name: card.name,
        number: card.number,
        expiry: card.expiry,
        securityCode: card.securityCode,
        billingAddress: { ...card.billingAddress },
      },
    }
  }
  return body
}

type Obj = Record<string, any>

/** Parse an Orders v2 response body (snake_case, as PayPal sends it). */
export function parseOrder(raw: unknown): ParsedOrder {
  const o = (raw ?? {}) as Obj
  const unit = (o.purchase_units?.[0] ?? {}) as Obj
  const auth = (unit.payments?.authorizations?.[0] ?? null) as Obj | null
  const captures = (unit.payments?.captures ?? []) as Obj[]
  const out: ParsedOrder = { orderId: String(o.id ?? ''), status: String(o.status ?? ''), captureIds: captures.map((c) => String(c.id)) }
  if (auth) {
    if (typeof auth.id === 'string') out.authorizationId = auth.id
    const st = asAuthStatus(auth.status)
    if (st) out.authStatus = st
    if (typeof auth.expiration_time === 'string') out.expiresAt = auth.expiration_time
    const pr = auth.processor_response as Obj | undefined
    if (pr) out.processorResponse = { responseCode: pr.response_code ?? null, avsCode: pr.avs_code ?? null, cvvCode: pr.cvv_code ?? null }
    if (st === 'DENIED') {
      const code = out.processorResponse?.responseCode
      out.declineReason = `Declined by the card processor${code ? ` (response code ${code})` : ''}. Not charged.`
    }
  }
  const link = ((o.links ?? []) as Obj[]).find((l) => l.rel === 'payer-action' || l.rel === 'approve')
  if (typeof link?.href === 'string') out.approveUrl = link.href
  return out
}

export function isDeclined(raw: unknown): boolean {
  return parseOrder(raw).authStatus === 'DENIED'
}

function orderResource(body: unknown) {
  const p = parseOrder(body)
  return { id: p.orderId || null, status: p.authStatus ? `${p.status}; auth=${p.authStatus}` : p.status || null }
}

export interface CreateAuthorizeOrderResult extends Omit<ParsedOrder, 'captureIds'> {
  raw: unknown
  ledgerCallId: string
}

export async function createAuthorizeOrder(p: {
  roomId: string
  fanId: string
  ceilingCents: number
  funding: Funding
  botCard?: TestCard
  /** Retry suffix -a{n}, only after a GET showed the earlier attempt's state. */
  attempt?: number
}): Promise<CreateAuthorizeOrderResult> {
  const body = buildAuthorizeOrder(p)
  const requestId = orderRequestId(p.roomId, p.fanId, p.attempt ?? 0)
  const res = await sdkCall(
    { op: 'orders.create', method: 'POST', endpoint: '/v2/checkout/orders', requestId, ctx: { roomId: p.roomId, fanId: p.fanId }, resource: orderResource },
    (c) => c.orders.createOrder({ body, paypalRequestId: requestId, prefer: PREFER_REPRESENTATION }),
  )
  const { captureIds: _ignored, ...parsed } = parseOrder(res.body)
  return { ...parsed, raw: redact(res.body), ledgerCallId: res.call.id }
}

export async function authorizeOrder(p: { roomId: string; fanId: string; orderId: string; attempt?: number }): Promise<{
  authorizationId: string
  authStatus: AuthStatus
  expiresAt?: string
  processorResponse?: ProcessorResponse
  declineReason?: string
  raw: unknown
}> {
  const requestId = authRequestId(p.roomId, p.fanId, p.attempt ?? 0)
  const res = await sdkCall(
    { op: 'orders.authorize', method: 'POST', endpoint: `/v2/checkout/orders/${p.orderId}/authorize`, requestId, ctx: { roomId: p.roomId, fanId: p.fanId }, resource: orderResource },
    (c) => c.orders.authorizeOrder({ id: p.orderId, paypalRequestId: requestId, prefer: PREFER_REPRESENTATION }),
  )
  const parsed = parseOrder(res.body)
  if (!parsed.authorizationId || !parsed.authStatus) throw localError('INVALID_RESPONSE', 'authorize response had no authorization')
  return {
    authorizationId: parsed.authorizationId,
    authStatus: parsed.authStatus,
    ...(parsed.expiresAt ? { expiresAt: parsed.expiresAt } : {}),
    ...(parsed.processorResponse ? { processorResponse: parsed.processorResponse } : {}),
    ...(parsed.declineReason ? { declineReason: parsed.declineReason } : {}),
    raw: redact(res.body),
  }
}

/** GET /v2/checkout/orders/{id} through the Agent Toolkit's get_order (redacted raw). */
export async function getOrder(id: string, ctx?: LedgerContext): Promise<ParsedOrder & { raw: unknown }> {
  const res = await toolkitCall({ op: 'orders.get:toolkit', tool: 'get_order', ctx, resource: orderResource }, { id })
  return { ...parseOrder(res.body), raw: redact(res.body) }
}
