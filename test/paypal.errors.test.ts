import { readFileSync } from 'node:fs'
import { ApiError } from '@paypal/paypal-server-sdk'
import { describe, expect, it } from 'vitest'
import { PayPalError, fromHttpResponse, toPayPalError } from '../src/server/paypal/errors.js'
import { invoiceId, orderRequestId } from '../src/server/paypal/requestIds.js'

const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/paypal/${name}.json`, import.meta.url), 'utf8')) as { status: number; debug_id: string; body: unknown }

describe('PayPal error mapping', () => {
  it('maps a REST error body (B_cap3: capture after the final capture)', () => {
    const f = fx('B_cap3')
    const e = fromHttpResponse(f.status, f.body)
    expect(e).toBeInstanceOf(PayPalError)
    expect(e).toMatchObject({ name: 'UNPROCESSABLE_ENTITY', httpStatus: 422, debugId: 'f7443682e25c9', issue: 'AUTHORIZATION_ALREADY_CAPTURED' })
    expect(e.details[0]?.description).toBe('Authorization has already been captured.')
    expect(e.links[0]?.rel).toBe('information_link')
  })

  it('prefers the response header debug id over a mocked body (F_mock)', () => {
    const f = fx('F_mock')
    expect(fromHttpResponse(f.status, f.body, { 'paypal-debug-id': f.debug_id }).debugId).toBe('f134684379619')
    expect(fromHttpResponse(f.status, f.body).debugId).toBe('70c28ae654da')
    expect(fromHttpResponse(f.status, f.body).issue).toBe('AUTHORIZATION_EXPIRED')
  })

  it('maps a Server SDK ApiError', () => {
    const f = fx('B_cap3')
    const sdkErr = new ApiError(
      { request: { method: 'POST', url: 'https://api-m.sandbox.paypal.com/v2/payments/authorizations/X/capture' }, response: { statusCode: 422, body: JSON.stringify(f.body), headers: { 'paypal-debug-id': 'hdr123' } } },
      'The request failed because it is semantically incorrect or failed business validation.',
    )
    const e = toPayPalError(sdkErr)
    expect(e).toMatchObject({ name: 'UNPROCESSABLE_ENTITY', httpStatus: 422, debugId: 'hdr123', issue: 'AUTHORIZATION_ALREADY_CAPTURED' })
  })

  it('maps OAuth errors', () => {
    const e = fromHttpResponse(401, { error: 'invalid_client', error_description: 'Client Authentication failed' })
    expect(e).toMatchObject({ name: 'invalid_client', httpStatus: 401, issue: 'invalid_client', message: 'Client Authentication failed' })
  })

  it('maps Agent Toolkit error JSON', () => {
    expect(toPayPalError({ ok: false, status: 422, code: 'PAYPAL_API_HTTP_ERROR', message: 'x' })).toMatchObject({ name: 'PAYPAL_API_HTTP_ERROR', httpStatus: 422 })
    expect(toPayPalError({ error: { message: 'Failed to fetch access token: x', type: 'paypal_error' } })).toMatchObject({ name: 'TOOLKIT_ERROR', httpStatus: 0 })
  })

  it('maps transport failures with httpStatus 0', () => {
    expect(toPayPalError(new TypeError('fetch failed'))).toMatchObject({ name: 'NETWORK_ERROR', httpStatus: 0 })
    expect(toPayPalError(new DOMException('timed out', 'TimeoutError'))).toMatchObject({ name: 'TIMEOUT', httpStatus: 0 })
    expect(toPayPalError(Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' }))).toMatchObject({ name: 'TIMEOUT', httpStatus: 0 })
    expect(toPayPalError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))).toMatchObject({ name: 'NETWORK_ERROR', httpStatus: 0 })
    expect(toPayPalError('weird')).toMatchObject({ name: 'INTERNAL_ERROR', httpStatus: 0 })
  })

  it('handles empty error bodies', () => {
    expect(fromHttpResponse(503, null)).toMatchObject({ name: 'HTTP_503', httpStatus: 503, debugId: null, issue: null })
  })

  it('serializes without a stack', () => {
    const json = JSON.parse(JSON.stringify(fromHttpResponse(422, fx('B_cap3').body)))
    expect(Object.keys(json).sort()).toEqual(['debugId', 'details', 'httpStatus', 'issue', 'message', 'name'])
  })
})

describe('PayPal-Request-Id scheme', () => {
  it('follows ARCHITECTURE.md', async () => {
    const ids = await import('../src/server/paypal/requestIds.js')
    expect(ids.orderRequestId('R', 'fan_1')).toBe('order-R-fan_1')
    expect(ids.authRequestId('R', 'fan_1')).toBe('auth-R-fan_1')
    expect(ids.settleRequestId('R', 'fan_1')).toBe('settle-R-fan_1')
    expect(ids.voidRequestId('R', 'fan_1')).toBe('void-R-fan_1')
    expect(ids.refundRequestId('ct_9')).toBe('refund-ct_9')
    expect(ids.payoutRequestId('R', 2)).toBe('payout-R-2')
    expect(ids.settleRequestId('R', 'fan_1', 2)).toBe('settle-R-fan_1-a2')
    expect(ids.settleRequestId('R', 'fan_1', 0)).toBe('settle-R-fan_1')
    expect(invoiceId('R', 'fan_1')).toBe('tab-R-fan_1')
    expect(ids.customId('R', 'fan_1')).toBe('R-fan_1')
  })

  it('is deterministic and only uses invoice-safe characters', () => {
    expect(orderRequestId('Ab3xYz9KmN', 'fan_QWErty12345678')).toBe(orderRequestId('Ab3xYz9KmN', 'fan_QWErty12345678'))
    expect(invoiceId('Ab3xYz9KmN', 'fan_QWErty12345678')).toMatch(/^[A-Za-z0-9_-]{1,127}$/)
  })

  it('rejects unsafe IDs and bad attempts as PayPalError', () => {
    expect(() => orderRequestId('room:1', 'fan')).toThrow(PayPalError)
    expect(() => orderRequestId('room', 'fan', -1)).toThrow(/attempt/)
    expect(() => orderRequestId('r'.repeat(60), 'f'.repeat(60))).toThrow(/too long/)
  })
})
