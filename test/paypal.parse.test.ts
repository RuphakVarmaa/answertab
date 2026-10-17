import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildAuthorizeOrder, holdDescription, isDeclined, parseOrder } from '../src/server/paypal/orders.js'
import { buildCapture, clip, mockHeader, parseAuthorization, parseCapture } from '../src/server/paypal/payments.js'
import { parseRefund } from '../src/server/paypal/refunds.js'
import { parseDispute } from '../src/server/paypal/disputes.js'
import { isDuplicatePayoutBatch, linkedBatchId, parsePayoutBatch, signedCents } from '../src/server/paypal/payouts.js'
import { fromHttpResponse } from '../src/server/paypal/errors.js'
import { DECLINE_NAME, TEST_CARDS, botCard, declineCard } from '../src/server/paypal/testCards.js'

const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/paypal/${name}.json`, import.meta.url), 'utf8')) as { status: number; debug_id: string; body: unknown }

describe('orders: parse real sandbox responses', () => {
  it('reads tab status from the authorization (A_authorize)', () => {
    const p = parseOrder(fx('A_authorize').body)
    expect(p).toMatchObject({
      orderId: '3AP42894X8638981S',
      status: 'COMPLETED',
      authorizationId: '844666162S1397447',
      authStatus: 'CREATED',
      expiresAt: '2026-11-14T06:42:34Z',
      processorResponse: { responseCode: '0000', avsCode: 'A', cvvCode: 'M' },
    })
    expect(p.declineReason).toBeUndefined()
    expect(isDeclined(fx('A_authorize').body)).toBe(false)
  })

  it('detects a processor decline: HTTP 201, order COMPLETED, authorization DENIED (E_reject)', () => {
    const f = fx('E_reject')
    expect(f.status).toBe(201)
    const p = parseOrder(f.body)
    expect(p.status).toBe('COMPLETED')
    expect(p.authStatus).toBe('DENIED')
    expect(p.authorizationId).toBe('7KN161340E5967534')
    expect(p.processorResponse?.responseCode).toBe('0500')
    expect(p.declineReason).toMatch(/0500/)
    expect(p.declineReason).toMatch(/Not charged/)
    expect(isDeclined(f.body)).toBe(true)
  })

  it('finds the payer-action link on wallet orders', () => {
    const p = parseOrder({ id: 'X', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'self', href: 'a' }, { rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=X' }] })
    expect(p.approveUrl).toContain('checkoutnow')
    expect(p.authStatus).toBeUndefined()
  })
})

describe('orders: request body', () => {
  const base = { roomId: 'Room123456', fanId: 'fan_abcDEF123', ceilingCents: 2000 }

  it('describes the hold in <= 127 chars and sets the ID fields', () => {
    expect(holdDescription(2000)).toBe('Hold up to $20.00. Charged only for questions answered on stream.')
    const b = buildAuthorizeOrder({ ...base, funding: 'paypal' })
    const unit = b.purchaseUnits[0]!
    expect(b.intent).toBe('AUTHORIZE')
    expect(unit.amount).toEqual({ currencyCode: 'USD', value: '20.00' })
    expect(unit.description!.length).toBeLessThanOrEqual(127)
    expect(unit.customId).toBe('Room123456-fan_abcDEF123')
    expect(unit.invoiceId).toBe('tab-Room123456-fan_abcDEF123')
    expect(unit.softDescriptor).toBe('AnswerTab')
  })

  it('wallet orders carry the experience context', () => {
    const b = buildAuthorizeOrder({ ...base, funding: 'paypal' })
    expect(b.paymentSource?.paypal?.experienceContext).toEqual({ brandName: 'AnswerTab', shippingPreference: 'NO_SHIPPING', userAction: 'CONTINUE' })
  })

  it('card-field orders put the context in application_context and send no card', () => {
    const b = buildAuthorizeOrder({ ...base, funding: 'card' })
    expect(b.paymentSource).toBeUndefined()
    expect(b.applicationContext).toEqual({ brandName: 'AnswerTab', shippingPreference: 'NO_SHIPPING', userAction: 'CONTINUE' })
  })

  it('bot orders include the test card and billing address', () => {
    const b = buildAuthorizeOrder({ ...base, funding: 'bot_card', botCard: declineCard() })
    expect(b.paymentSource?.card).toMatchObject({ name: DECLINE_NAME, number: TEST_CARDS[0]!.number, expiry: '2030-12', securityCode: '123' })
    expect(b.paymentSource?.card?.billingAddress?.countryCode).toBe('US')
  })

  it('rejects a zero or fractional ceiling', () => {
    expect(() => buildAuthorizeOrder({ ...base, ceilingCents: 0, funding: 'card' })).toThrow(/> 0/)
    expect(() => buildAuthorizeOrder({ ...base, ceilingCents: 10.5, funding: 'card' })).toThrow()
  })

  it('rotates bot cards', () => {
    expect(botCard(0).brand).toBe('VISA')
    expect(botCard(5).brand).toBe(TEST_CARDS[1]!.brand)
    expect(botCard(-1).brand).toBe(TEST_CARDS[TEST_CARDS.length - 1]!.brand)
    expect(botCard(2, 'Bot Ava').name).toBe('Bot Ava')
  })
})

describe('payments: parse real sandbox responses', () => {
  it('splits seller_receivable_breakdown into integer cents (A_cap1)', () => {
    const c = parseCapture(fx('A_cap1').body)
    expect(c).toMatchObject({ captureId: '5V685566E5143111P', status: 'COMPLETED', grossCents: 500, feeCents: 62, netCents: 438, finalCapture: false, authorizationId: '844666162S1397447' })
  })

  it('reads a final capture (C_settle)', () => {
    const c = parseCapture(fx('C_settle').body)
    expect(c).toMatchObject({ captureId: '1D935081UL680922X', grossCents: 700, feeCents: 67, netCents: 633, finalCapture: true, authorizationId: '85971157JW459961R' })
    expect(c.grossCents - c.feeCents!).toBe(c.netCents)
  })

  it('the replay fixture returned the identical capture', () => {
    expect(fx('A_cap1_replay').status).toBe(200)
    expect(parseCapture(fx('A_cap1_replay').body).captureId).toBe(parseCapture(fx('A_cap1').body).captureId)
  })

  it('keeps PENDING as pending, with no invented fee', () => {
    const c = parseCapture({ id: 'P1', status: 'PENDING', status_details: { reason: 'PENDING_REVIEW' }, amount: { currency_code: 'USD', value: '3.00' } })
    expect(c).toMatchObject({ status: 'PENDING', statusReason: 'PENDING_REVIEW', grossCents: 300, feeCents: null, netCents: null })
  })

  it('reads authorizations (B_get, A_void)', () => {
    expect(parseAuthorization(fx('B_get').body)).toMatchObject({ authorizationId: '3UW07605EH995784T', status: 'CAPTURED', amountCents: 1000, orderId: '2BJ50537YH418494U' })
    expect(parseAuthorization(fx('A_void').body).status).toBe('VOIDED')
    expect(parseAuthorization(fx('F_void').body).status).toBe('VOIDED')
  })

  it('builds one final capture with a clipped note and the tab invoice id', () => {
    const b = buildCapture({ roomId: 'R1', fanId: 'fan_1', amountCents: 700, noteToPayer: 'x'.repeat(300) })
    expect(b).toMatchObject({ amount: { currencyCode: 'USD', value: '7.00' }, finalCapture: true, invoiceId: 'tab-R1-fan_1' })
    expect(b.noteToPayer!.length).toBe(255)
    expect(() => buildCapture({ roomId: 'R1', fanId: 'fan_1', amountCents: 0, noteToPayer: '' })).toThrow(/void/)
  })

  it('never splits a surrogate pair when clipping', () => {
    const s = 'a'.repeat(254) + '😀'
    expect(clip(s, 255)).toBe('a'.repeat(254))
  })

  it('formats PayPal-Mock-Response', () => {
    expect(mockHeader('AUTHORIZATION_EXPIRED')).toBe('{"mock_application_codes":"AUTHORIZATION_EXPIRED"}')
    expect(mockHeader('{"mock_application_codes":"X"}')).toBe('{"mock_application_codes":"X"}')
    expect(mockHeader(undefined)).toBeUndefined()
    expect(() => mockHeader('bad code')).toThrow()
  })
})

describe('refunds, disputes, payouts', () => {
  it('PayPal keeps the original fee on refunds (A_refund)', () => {
    expect(parseRefund(fx('A_refund').body)).toEqual({
      refundId: '8Y107089L7946373A',
      status: 'COMPLETED',
      grossCents: 200,
      feeReturnedCents: 0,
      netCents: 200,
      captureId: '98S54918JH246923M',
    })
  })

  it('a minimal refund response (no Prefer header) still yields the id', () => {
    const r = parseRefund({ id: 'R1', status: 'COMPLETED', links: [] })
    expect(r).toMatchObject({ refundId: 'R1', status: 'COMPLETED', grossCents: 0 })
  })

  it('maps a dispute to its capture via seller_transaction_id', () => {
    const d = parseDispute({
      dispute_id: 'PP-D-12345',
      status: 'OPEN',
      reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
      dispute_amount: { currency_code: 'USD', value: '7.00' },
      dispute_life_cycle_stage: 'INQUIRY',
      disputed_transactions: [{ seller_transaction_id: '1D935081UL680922X', buyer_transaction_id: 'B1' }],
    })
    expect(d).toMatchObject({ disputeId: 'PP-D-12345', amountCents: 700, stage: 'INQUIRY' })
    expect(d.disputedTransactions[0]!.sellerTransactionId).toBe('1D935081UL680922X')
  })

  it('reads payout batches and signed balances', () => {
    const b = parsePayoutBatch({
      batch_header: { payout_batch_id: 'B1', batch_status: 'SUCCESS', sender_batch_header: { sender_batch_id: 'payout-R-1' }, amount: { value: '1.00', currency: 'USD' }, fees: { value: '0.25', currency: 'USD' } },
      items: [{ payout_item_id: 'I1', transaction_status: 'UNCLAIMED', payout_item_fee: { value: '0.25' }, payout_item: { receiver: 'sb-abcdef@personal.example.com', amount: { value: '1.00' }, sender_item_id: 'payout-R-1-1' } }],
    })
    expect(b).toMatchObject({ payoutBatchId: 'B1', senderBatchId: 'payout-R-1', batchStatus: 'SUCCESS', amountCents: 100, feeCents: 25 })
    expect(b.items[0]).toMatchObject({ transactionStatus: 'UNCLAIMED', feeCents: 25, receiver: 'sb-a***@personal.example.com' })
    expect(signedCents('-1.5')).toBe(-150)
    expect(signedCents('5000.00')).toBe(500000)
    expect(signedCents('abc')).toBeNull()
  })

  it('recognizes the sandbox duplicate sender_batch_id rejection', () => {
    const body = {
      name: 'USER_BUSINESS_ERROR',
      message: 'User business error.',
      debug_id: 'f640099446bff',
      details: [{ field: 'SENDER_BATCH_ID', location: 'body', issue: 'Batch with given sender_batch_id already exists' }],
    }
    expect(isDuplicatePayoutBatch(fromHttpResponse(400, body))).toBe(true)
    expect(isDuplicatePayoutBatch(fromHttpResponse(400, { name: 'VALIDATION_ERROR', details: [{ issue: 'x', field: 'items[0].receiver' }] }))).toBe(false)
  })
})

describe('fixtures from scripts/sandbox-proof (real, redacted)', () => {
  it('wallet orders: HTTP 200 PAYER_ACTION_REQUIRED with an approval link, no authorization yet', () => {
    const f = fx('I_order_wallet')
    expect(f.status).toBe(200)
    const p = parseOrder(f.body)
    expect(p.status).toBe('PAYER_ACTION_REQUIRED')
    expect(p.approveUrl).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\/checkoutnow\?token=/)
    expect(p.authStatus).toBeUndefined()
  })

  it('card-field orders start CREATED; authorize returns the authorization', () => {
    expect(parseOrder(fx('I_order_card_created').body)).toMatchObject({ status: 'CREATED', captureIds: [] })
    const a = parseOrder(fx('I_order_authorize').body)
    expect(a.status).toBe('COMPLETED')
    expect(a.authStatus).toBe('CREATED')
    expect(a.authorizationId).toMatch(/^[A-Z0-9]{17}$/)
  })

  it('toolkit create_refund returns a minimal body; get_refund has the breakdown', () => {
    const created = parseRefund(fx('H_refund_toolkit_create').body)
    expect(created.status).toBe('COMPLETED')
    expect(created.grossCents).toBe(0)
    const got = parseRefund(fx('H_refund_toolkit_get').body)
    expect(got).toMatchObject({ refundId: created.refundId, grossCents: 300, feeReturnedCents: 0, netCents: 300 })
  })

  it('payout batch create and get', () => {
    const c = parsePayoutBatch(fx('G_payout_create').body)
    expect(c.batchStatus).toBe('PENDING')
    const g = parsePayoutBatch(fx('G_payout_get').body)
    expect(g.payoutBatchId).toBe(c.payoutBatchId)
    expect(g.senderBatchId).toMatch(/^payout-proof[A-Za-z0-9]+-1$/)
    expect(g.items[0]).toMatchObject({ transactionStatus: 'PENDING', amountCents: 100, receiver: 'sb-u***@personal.example.com' })
  })

  it('a duplicate sender_batch_id links the original batch under details[].link', () => {
    const f = fx('G_payout_dup')
    const e = fromHttpResponse(f.status, f.body)
    expect(isDuplicatePayoutBatch(e)).toBe(true)
    expect(linkedBatchId(e)).toBe(parsePayoutBatch(fx('G_payout_create').body).payoutBatchId)
  })

  it('a missing dispute maps to RESOURCE_NOT_FOUND', () => {
    const f = fx('J_dispute_404')
    expect(fromHttpResponse(f.status, f.body)).toMatchObject({ httpStatus: 404, issue: 'RESOURCE_NOT_FOUND' })
  })
})
