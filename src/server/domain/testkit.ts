// Test kit (never used by the running server): a fixture-shaped fake of the PayPal module for vi.mock, and a
// routed fake Claude client that answers intake, detector, verifier and contest-desk calls from simple rules.
// The fakes build raw bodies in PayPal's wire shape (see test/fixtures/paypal) and run them through the real parsers.
import type { VerdictKind } from '../../shared/types.js'
import type * as PayPal from '../paypal/index.js'
import type { ClaudeClient, CreateParams } from '../ai/anthropic.js'
import { fakeMessage, type FakeStep } from '../ai/fakeClient.js'

type PP = typeof PayPal
type Obj = Record<string, any>

// ---------------------------------------------------------------- PayPal

export type FakeFailure = 'lost' | { status: number; name: string; issue?: string }

export interface FakePayPalState {
  /** Every call: op name, request id (writes) and key args. */
  calls: { op: string; requestId: string | null; args: Obj }[]
  orders: Map<string, { roomId: string; fanId: string; ceilingCents: number; funding: string; approved: boolean; authId: string | null; captureIds: string[]; cardName: string | null }>
  auths: Map<string, { orderId: string; amountCents: number; status: string }>
  captures: Map<string, { authId: string; grossCents: number; status: string; refundedCents: number; invoiceId: string }>
  refunds: Map<string, { captureId: string; grossCents: number; status: string }>
  payouts: Map<string, { senderBatchId: string; amountCents: number; receiver: string; status: string; polls: number }>
  disputes: Map<string, Obj>
  /** Responses by PayPal-Request-Id, so a repeated write replays like PayPal does. */
  replies: Map<string, unknown>
  /** One-shot failures by op ('captureTab', 'voidTab', ...). 'lost' applies the write, then loses the response. */
  failNext: Map<string, FakeFailure>
  /** Status new captures get (PENDING exercises the "never shown as paid" path). */
  captureStatus: 'COMPLETED' | 'PENDING'
  /** What webhook verification answers ('unknown' = the verify call failed transiently). */
  webhookVerifies: boolean | 'unknown'
  /** Marks a card/PayPal order approved, as the browser's card fields or PayPal button would. */
  approve(orderId: string): void
  reset(): void
}

let seq = 0
const pid = (prefix: string) => `${prefix}${String(++seq).padStart(6, '0')}TEST${Math.random().toString(36).slice(2, 8).toUpperCase()}`
const money = (cents: number) => ({ currency_code: 'USD', value: `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}` })
/** PayPal's published US card rate shape (2.89% + $0.29), only so fees are non-zero and fixture-like. */
const fakeFee = (gross: number) => Math.round((gross * 289) / 10_000) + 29

export function makeFakePayPal(actual: PP): Partial<PP> & { __fake: FakePayPalState } {
  const s: FakePayPalState = {
    calls: [],
    orders: new Map(),
    auths: new Map(),
    captures: new Map(),
    refunds: new Map(),
    payouts: new Map(),
    disputes: new Map(),
    replies: new Map(),
    failNext: new Map(),
    captureStatus: 'COMPLETED',
    webhookVerifies: true,
    approve(orderId) {
      const o = s.orders.get(orderId)
      if (o) o.approved = true
    },
    reset() {
      for (const m of [s.orders, s.auths, s.captures, s.refunds, s.payouts, s.disputes, s.replies, s.failNext]) m.clear()
      s.calls.length = 0
      s.captureStatus = 'COMPLETED'
      s.webhookVerifies = true
    },
  }

  const ppError = (status: number, name: string, issue?: string) =>
    new actual.PayPalError({ name, message: `${name}${issue ? ` (${issue})` : ''}`, httpStatus: status, debugId: `dbg${++seq}`, ...(issue ? { details: [{ issue }] } : {}) })

  async function ledger(op: string, method: string, endpoint: string, requestId: string | null, httpStatus: number, ctx: PayPal.LedgerContext, resourceId: string | null, resourceStatus: string | null, request?: unknown, response?: unknown) {
    return actual.record({ op, method, endpoint, requestId, httpStatus, resourceId, resourceStatus, debugId: `dbg${++seq}`, latencyMs: 5, ctx, request, response })
  }

  /** Runs a write once per request id; injected failures apply here. */
  async function write<T>(op: string, requestId: string, args: Obj, run: () => Promise<T>): Promise<T> {
    s.calls.push({ op, requestId, args })
    const fail = s.failNext.get(op)
    if (fail && fail !== 'lost') {
      s.failNext.delete(op)
      throw ppError(fail.status, fail.name, fail.issue)
    }
    let out: T
    if (s.replies.has(requestId)) out = s.replies.get(requestId) as T
    else {
      out = await run()
      s.replies.set(requestId, out)
    }
    if (fail === 'lost') {
      s.failNext.delete(op)
      throw ppError(0, 'TIMEOUT')
    }
    return out
  }

  const orderBody = (orderId: string): Obj => {
    const o = s.orders.get(orderId)!
    const a = o.authId ? s.auths.get(o.authId) : null
    const captures = o.captureIds.map((id) => captureBody(id))
    const denied = a?.status === 'DENIED'
    return {
      id: orderId,
      intent: 'AUTHORIZE',
      status: a ? 'COMPLETED' : o.approved ? 'APPROVED' : 'CREATED',
      purchase_units: [
        {
          amount: money(o.ceilingCents),
          invoice_id: actual.requestIds.invoiceId(o.roomId, o.fanId),
          payments: a
            ? {
                authorizations: [
                  {
                    id: o.authId,
                    status: a.status,
                    amount: money(a.amountCents),
                    expiration_time: '2026-11-14T06:43:19Z',
                    processor_response: { avs_code: 'A', cvv_code: 'M', response_code: denied ? '0500' : '0000' },
                  },
                ],
                ...(captures.length ? { captures } : {}),
              }
            : undefined,
        },
      ],
      links: [{ href: `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`, rel: 'payer-action', method: 'GET' }],
    }
  }

  const captureBody = (id: string): Obj => {
    const c = s.captures.get(id)!
    const fee = fakeFee(c.grossCents)
    return {
      id,
      status: c.status,
      amount: money(c.grossCents),
      final_capture: true,
      invoice_id: c.invoiceId,
      ...(c.status === 'PENDING'
        ? { status_details: { reason: 'PENDING_REVIEW' } }
        : { seller_receivable_breakdown: { gross_amount: money(c.grossCents), paypal_fee: money(fee), net_amount: money(c.grossCents - fee) } }),
      supplementary_data: { related_ids: { authorization_id: c.authId } },
      links: [{ href: `https://api.sandbox.paypal.com/v2/payments/authorizations/${c.authId}`, rel: 'up', method: 'GET' }],
    }
  }

  const fake: Partial<PP> = {
    async createAuthorizeOrder(p) {
      const requestId = actual.requestIds.orderRequestId(p.roomId, p.fanId, p.attempt ?? 0)
      const orderId = await write('createAuthorizeOrder', requestId, { ceilingCents: p.ceilingCents, funding: p.funding }, async () => {
        const id = pid('ORD')
        const cardName = p.funding === 'bot_card' ? (p.botCard?.name ?? 'Bot Visa') : null
        s.orders.set(id, { roomId: p.roomId, fanId: p.fanId, ceilingCents: p.ceilingCents, funding: p.funding, approved: p.funding === 'bot_card', authId: null, captureIds: [], cardName })
        if (p.funding === 'bot_card') {
          const authId = pid('AUTH')
          s.auths.set(authId, { orderId: id, amountCents: p.ceilingCents, status: cardName === actual.DECLINE_NAME ? 'DENIED' : 'CREATED' })
          s.orders.get(id)!.authId = authId
        }
        return id
      })
      const body = orderBody(orderId)
      const call = await ledger('orders.create', 'POST', '/v2/checkout/orders', requestId, 201, { roomId: p.roomId, fanId: p.fanId }, orderId, body.status, { body: { intent: 'AUTHORIZE' } }, body)
      const { captureIds: _c, ...parsed } = actual.parseOrder(body)
      return { ...parsed, raw: body, ledgerCallId: call.id }
    },

    async authorizeOrder(p) {
      const requestId = actual.requestIds.authRequestId(p.roomId, p.fanId, p.attempt ?? 0)
      const o = s.orders.get(p.orderId)
      if (!o) throw ppError(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID')
      if (!o.approved) {
        s.calls.push({ op: 'authorizeOrder', requestId, args: { orderId: p.orderId } })
        await ledger('orders.authorize', 'POST', `/v2/checkout/orders/${p.orderId}/authorize`, requestId, 422, { roomId: p.roomId, fanId: p.fanId }, null, 'ORDER_NOT_APPROVED')
        throw ppError(422, 'UNPROCESSABLE_ENTITY', 'ORDER_NOT_APPROVED')
      }
      await write('authorizeOrder', requestId, { orderId: p.orderId }, async () => {
        if (!o.authId) {
          const authId = pid('AUTH')
          s.auths.set(authId, { orderId: p.orderId, amountCents: o.ceilingCents, status: 'CREATED' })
          o.authId = authId
        }
        return o.authId
      })
      const body = orderBody(p.orderId)
      await ledger('orders.authorize', 'POST', `/v2/checkout/orders/${p.orderId}/authorize`, requestId, 201, { roomId: p.roomId, fanId: p.fanId }, p.orderId, 'COMPLETED', undefined, body)
      const parsed = actual.parseOrder(body)
      return {
        authorizationId: parsed.authorizationId!,
        authStatus: parsed.authStatus!,
        ...(parsed.expiresAt ? { expiresAt: parsed.expiresAt } : {}),
        ...(parsed.declineReason ? { declineReason: parsed.declineReason } : {}),
        raw: body,
      }
    },

    async getOrder(id, ctx) {
      s.calls.push({ op: 'getOrder', requestId: null, args: { id } })
      if (!s.orders.has(id)) throw ppError(404, 'RESOURCE_NOT_FOUND')
      const body = orderBody(id)
      await ledger('orders.get:toolkit', 'GET', `/v2/checkout/orders/${id}`, null, 200, ctx ?? {}, id, body.status)
      return { ...actual.parseOrder(body), raw: body }
    },

    async captureTab(p) {
      const requestId = actual.requestIds.settleRequestId(p.roomId, p.fanId, p.attempt ?? 0)
      const captureId = await write('captureTab', requestId, { amountCents: p.amountCents, noteToPayer: p.noteToPayer, authorizationId: p.authorizationId }, async () => {
        const a = s.auths.get(p.authorizationId)
        if (!a) throw ppError(404, 'RESOURCE_NOT_FOUND')
        if (a.status === 'CAPTURED') throw ppError(422, 'UNPROCESSABLE_ENTITY', 'AUTHORIZATION_ALREADY_CAPTURED')
        if (a.status !== 'CREATED') throw ppError(422, 'UNPROCESSABLE_ENTITY', `AUTHORIZATION_${a.status}`)
        if (p.amountCents > a.amountCents) throw ppError(422, 'UNPROCESSABLE_ENTITY', 'MAX_CAPTURE_AMOUNT_EXCEEDED')
        const id = pid('CAP')
        s.captures.set(id, { authId: p.authorizationId, grossCents: p.amountCents, status: s.captureStatus, refundedCents: 0, invoiceId: actual.requestIds.invoiceId(p.roomId, p.fanId) })
        a.status = 'CAPTURED'
        s.orders.get(a.orderId)?.captureIds.push(id)
        return id
      })
      const body = captureBody(captureId)
      const call = await ledger(
        'payments.capture', 'POST', `/v2/payments/authorizations/${p.authorizationId}/capture`, requestId, 201, { roomId: p.roomId, fanId: p.fanId },
        captureId, body.status, { authorization_id: p.authorizationId, body: { amount: money(p.amountCents), final_capture: true, note_to_payer: p.noteToPayer } }, body,
      )
      return { ...actual.parseCapture(body), raw: body, ledgerCallId: call.id }
    },

    async voidTab(p) {
      const requestId = actual.requestIds.voidRequestId(p.roomId, p.fanId, p.attempt ?? 0)
      await write('voidTab', requestId, { authorizationId: p.authorizationId }, async () => {
        const a = s.auths.get(p.authorizationId)
        if (!a) throw ppError(404, 'RESOURCE_NOT_FOUND')
        if (a.status !== 'CREATED' && a.status !== 'VOIDED') throw ppError(422, 'UNPROCESSABLE_ENTITY', `AUTHORIZATION_${a.status}`)
        a.status = 'VOIDED'
        return true
      })
      await ledger('payments.void', 'POST', `/v2/payments/authorizations/${p.authorizationId}/void`, requestId, 200, { roomId: p.roomId, fanId: p.fanId }, p.authorizationId, 'VOIDED')
      return { status: 'VOIDED', raw: { id: p.authorizationId, status: 'VOIDED' } }
    },

    async getAuthorization(id, ctx) {
      s.calls.push({ op: 'getAuthorization', requestId: null, args: { id } })
      const a = s.auths.get(id)
      if (!a) throw ppError(404, 'RESOURCE_NOT_FOUND')
      const body = { id, status: a.status, amount: money(a.amountCents), expiration_time: '2026-11-14T06:43:19Z', supplementary_data: { related_ids: { order_id: a.orderId } } }
      await ledger('payments.authorization.get', 'GET', `/v2/payments/authorizations/${id}`, null, 200, ctx ?? {}, id, a.status)
      return { ...actual.parseAuthorization(body), raw: body }
    },

    async getCapture(id, ctx) {
      s.calls.push({ op: 'getCapture', requestId: null, args: { id } })
      if (!s.captures.has(id)) throw ppError(404, 'RESOURCE_NOT_FOUND')
      const body = captureBody(id)
      await ledger('payments.capture.get', 'GET', `/v2/payments/captures/${id}`, null, 200, ctx ?? {}, id, body.status)
      return { ...actual.parseCapture(body), raw: body }
    },

    async replayCapture(callId) {
      const row = await actual.getLedgerCall(callId)
      if (!row || row.op !== 'payments.capture' || !row.request_id) throw ppError(0, 'NOT_REPLAYABLE')
      s.calls.push({ op: 'replayCapture', requestId: row.request_id, args: { callId } })
      const captureId = s.replies.get(row.request_id) as string
      await ledger('payments.capture.replay', 'POST', row.endpoint, row.request_id, 200, { roomId: row.room_id, tabId: row.tab_id }, captureId, s.captures.get(captureId)?.status ?? null)
      return { captureId, sameAsOriginal: captureId === row.resource_id, originalCaptureId: row.resource_id ?? '', httpStatus: 200 }
    },

    async refundShare(p) {
      const requestId = actual.requestIds.refundRequestId(p.contestId)
      const refundId = await write('refundShare', requestId, { captureId: p.captureId, amountCents: p.amountCents }, async () => {
        const c = s.captures.get(p.captureId)
        if (!c) throw ppError(404, 'RESOURCE_NOT_FOUND')
        if (c.refundedCents + p.amountCents > c.grossCents) throw ppError(422, 'UNPROCESSABLE_ENTITY', 'REFUND_AMOUNT_EXCEEDED')
        c.refundedCents += p.amountCents
        const id = pid('RF')
        s.refunds.set(id, { captureId: p.captureId, grossCents: p.amountCents, status: 'COMPLETED' })
        return id
      })
      const r = s.refunds.get(refundId)!
      const body = { id: refundId, status: r.status, amount: money(r.grossCents), seller_payable_breakdown: { gross_amount: money(r.grossCents), paypal_fee: money(0), net_amount: money(r.grossCents) } }
      await ledger('refunds.create:toolkit', 'POST', `/v2/payments/captures/${p.captureId}/refund`, requestId, 201, { contestId: p.contestId }, refundId, r.status)
      return { ...actual.parseRefund(body), captureId: p.captureId, path: 'toolkit' as const, raw: body }
    },

    async getRefund(id, ctx) {
      s.calls.push({ op: 'getRefund', requestId: null, args: { id } })
      const r = s.refunds.get(id)
      if (!r) throw ppError(404, 'RESOURCE_NOT_FOUND')
      const body = { id, status: r.status, amount: money(r.grossCents), seller_payable_breakdown: { gross_amount: money(r.grossCents), paypal_fee: money(0), net_amount: money(r.grossCents) } }
      await ledger('refunds.get:toolkit', 'GET', `/v2/payments/refunds/${id}`, null, 200, ctx ?? {}, id, r.status)
      return { ...actual.parseRefund(body), raw: body }
    },

    async createPayout(p) {
      const senderBatchId = actual.requestIds.payoutRequestId(p.roomId, p.attempt)
      const existing = [...s.payouts.entries()].find(([, b]) => b.senderBatchId === senderBatchId)
      s.calls.push({ op: 'createPayout', requestId: senderBatchId, args: { amountCents: p.amountCents, receiver: p.receiverEmail, note: p.note } })
      if (existing) return { payoutBatchId: existing[0], batchStatus: existing[1].status, senderBatchId, recovered: true }
      const id = pid('PB')
      s.payouts.set(id, { senderBatchId, amountCents: p.amountCents, receiver: p.receiverEmail, status: 'PENDING', polls: 0 })
      await ledger('payouts.create', 'POST', '/v1/payments/payouts', senderBatchId, 201, { roomId: p.roomId }, id, 'PENDING')
      const fail = s.failNext.get('createPayout')
      if (fail === 'lost') {
        s.failNext.delete('createPayout')
        throw ppError(0, 'TIMEOUT')
      }
      return { payoutBatchId: id, batchStatus: 'PENDING', senderBatchId, recovered: false }
    },

    async getPayoutBatch(id, ctx) {
      s.calls.push({ op: 'getPayoutBatch', requestId: null, args: { id } })
      const b = s.payouts.get(id)
      if (!b) throw ppError(404, 'RESOURCE_NOT_FOUND')
      b.polls++
      if (b.polls >= 1) b.status = 'SUCCESS'
      const body = {
        batch_header: { payout_batch_id: id, batch_status: b.status, sender_batch_header: { sender_batch_id: b.senderBatchId }, amount: { value: money(b.amountCents).value, currency: 'USD' }, fees: { value: '0.25', currency: 'USD' } },
        items: [{ payout_item_id: `${id}-1`, transaction_status: b.status === 'SUCCESS' ? 'SUCCESS' : 'PENDING', payout_item_fee: { value: '0.25', currency: 'USD' }, payout_item: { amount: { value: money(b.amountCents).value, currency: 'USD' }, receiver: b.receiver, sender_item_id: `${b.senderBatchId}-1` } }],
      }
      await ledger('payouts.get', 'GET', `/v1/payments/payouts/${id}`, null, 200, ctx ?? {}, id, b.status)
      return { ...actual.parsePayoutBatch(body), raw: body }
    },

    async getDispute(id) {
      s.calls.push({ op: 'getDispute', requestId: null, args: { id } })
      const d = s.disputes.get(id)
      if (!d) throw ppError(404, 'RESOURCE_NOT_FOUND')
      return { ...actual.parseDispute(d), raw: d }
    },

    async verifyWebhook() {
      s.calls.push({ op: 'verifyWebhook', requestId: null, args: {} })
      return s.webhookVerifies === true
    },

    async verifyWebhookResult() {
      s.calls.push({ op: 'verifyWebhook', requestId: null, args: {} })
      return s.webhookVerifies === 'unknown' ? 'unknown' : s.webhookVerifies ? 'verified' : 'rejected'
    },

    async accessToken() {
      return 'fake-token'
    },
    async getBalances() {
      return { balances: [{ currency: 'USD', totalCents: 500_000, availableCents: 500_000, withheldCents: 0, primary: true }], asOf: null, raw: {} }
    },
    async listWebhooks() {
      return []
    },
  }
  return { ...fake, __fake: s }
}

// ---------------------------------------------------------------- Claude

export interface DetectRule {
  question: number
  /** Words to find in one transcript segment (case and punctuation ignored). */
  phrase: string
  verdict: VerdictKind
  confidence: number
}

export interface RoutedClaudeOptions {
  intake?: (text: string, open: number[]) => { allow: boolean; reject_reason?: string; clean_text?: string; cues?: string[]; similar_to?: number | null }
  detect?: DetectRule[]
  verify?: (quote: string) => { agree: boolean; reason: string }
  /** Contest desk turns, in order (the last repeats). */
  contest?: FakeStep[]
  /** Throw on every detector call (exercises manual mode). */
  detectThrows?: unknown
}

export type CallKind = 'intake' | 'detect' | 'verify' | 'contest'

function userText(params: CreateParams): string[] {
  const out: string[] = []
  for (const m of params.messages) {
    if (m.role !== 'user') continue
    if (typeof m.content === 'string') out.push(m.content)
    else for (const b of m.content as Obj[]) if (b.type === 'text' && typeof b.text === 'string') out.push(b.text)
  }
  return out
}

export function classify(params: CreateParams): CallKind {
  if (Array.isArray(params.tools) && params.tools.length > 0) return 'contest'
  if (String(params.model).includes('opus')) return 'verify'
  const text = userText(params).join('\n')
  return text.includes('<transcript>') ? 'detect' : 'intake'
}

const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

/** Finds the phrase in the rendered transcript (`[seg N | ..] [0]w [1]w ...`) and returns its word span. */
export function findSpan(transcript: string, phrase: string): { startSeg: number; startWord: number; endSeg: number; endWord: number } | null {
  const want = phrase.split(/\s+/).map(norm).filter(Boolean)
  if (want.length === 0) return null
  for (const line of transcript.split('\n')) {
    const m = /^\[seg (\d+) \|[^\]]*\] (.*)$/.exec(line)
    if (!m) continue
    const words = [...m[2]!.matchAll(/\[(\d+)\](\S+)/g)].map((x) => norm(x[2]!))
    for (let i = 0; i + want.length <= words.length; i++) {
      if (want.every((w, j) => words[i + j] === w)) return { startSeg: Number(m[1]), startWord: i, endSeg: Number(m[1]), endWord: i + want.length - 1 }
    }
  }
  return null
}

export function routedClaude(opts: RoutedClaudeOptions): ClaudeClient & { requests: { kind: CallKind; params: CreateParams }[] } {
  const requests: { kind: CallKind; params: CreateParams }[] = []
  let contestTurn = 0
  return {
    requests,
    async create(params) {
      const kind = classify(params)
      requests.push({ kind, params: JSON.parse(JSON.stringify(params)) as CreateParams })
      const text = userText(params)
      if (kind === 'intake') {
        const q = /<question>\n([\s\S]*?)\n<\/question>/.exec(text.join('\n'))?.[1] ?? ''
        const open = [...text.join('\n').matchAll(/^Q(\d+):/gm)].map((m) => Number(m[1]))
        const r = opts.intake?.(q, open) ?? { allow: true }
        return fakeMessage({
          text: JSON.stringify({ allow: r.allow, reject_reason: r.reject_reason ?? (r.allow ? 'none' : 'off_topic'), clean_text: r.clean_text ?? q, cues: r.cues ?? [], similar_to: r.similar_to ?? null }),
        }, params.model)
      }
      if (kind === 'detect') {
        if (opts.detectThrows) throw opts.detectThrows
        const [questions = '', transcript = ''] = text
        const open = new Set([...questions.matchAll(/^Q(\d+) \|/gm)].map((m) => Number(m[1])))
        const verdicts = []
        for (const r of opts.detect ?? []) {
          if (!open.has(r.question)) continue
          const span = findSpan(transcript, r.phrase)
          if (!span) continue
          verdicts.push({ question_number: r.question, verdict: r.verdict, evidence: { start_seg: span.startSeg, start_word: span.startWord, end_seg: span.endSeg, end_word: span.endWord }, confidence: r.confidence })
        }
        return fakeMessage({ text: JSON.stringify({ verdicts }) }, params.model)
      }
      if (kind === 'verify') {
        const quote = /<quote>\n([\s\S]*?)\n<\/quote>/.exec(text.join('\n'))?.[1] ?? ''
        return fakeMessage({ text: JSON.stringify(opts.verify?.(quote) ?? { agree: true, reason: 'The quote answers the question.' }) }, params.model)
      }
      const steps = opts.contest ?? [{ text: 'No decision.' }]
      const step = steps[Math.min(contestTurn++, steps.length - 1)]!
      if ('throw' in step) throw step.throw
      return fakeMessage(step, params.model)
    },
  }
}

/** A contest-desk tool call block for scripted steps. */
export const toolUse = (id: string, name: string, input: Obj = {}) => ({ type: 'tool_use', id, name, input, caller: null })
