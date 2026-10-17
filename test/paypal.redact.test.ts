import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { maskEmail, pickHeaders, redact, scrubString } from '../src/server/paypal/redact.js'

const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/paypal/${name}.json`, import.meta.url), 'utf8')) as { body: unknown }

// What the ledger stores for a bot_card order request (wire format).
const botOrderWire = {
  intent: 'AUTHORIZE',
  payment_source: {
    card: {
      name: 'Bot Visa',
      number: '4111111111111111',
      expiry: '2030-12',
      security_code: '123',
      billing_address: { address_line_1: '2211 N First Street', admin_area_2: 'San Jose', admin_area_1: 'CA', postal_code: '95131', country_code: 'US' },
    },
  },
  purchase_units: [{ amount: { currency_code: 'USD', value: '20.00' }, invoice_id: 'tab-R-fan_1' }],
}

describe('redaction', () => {
  it('removes card number, CVV, expiry and billing address from requests', () => {
    const out = JSON.stringify(redact(botOrderWire))
    for (const secret of ['4111111111111111', '2030-12', '"123"', '2211 N First', '95131', 'Bot Visa']) expect(out).not.toContain(secret)
    expect(out).toContain('tab-R-fan_1')
    expect(out).toContain('20.00')
  })

  it('redacts card data and masks emails in real responses (A_authorize)', () => {
    const r = redact(fx('A_authorize').body) as any
    const card = r.payment_source.card
    expect(card.expiry).toBe('[redacted]')
    expect(card.name).toBe('[redacted]')
    expect(card.last_digits).toBe('1111')
    expect(card.brand).toBe('VISA')
    expect(r.purchase_units[0].payee.email_address).toBe('sb-u***@business.example.com')
    expect(r.purchase_units[0].payments.authorizations[0].id).toBe('844666162S1397447')
  })

  it('keeps the sandbox decline trigger name visible (E_reject)', () => {
    const r = redact(fx('E_reject').body) as any
    expect(r.payment_source.card.name).toBe('CCREJECT-REFUSED')
    expect(r.payment_source.card.expiry).toBe('[redacted]')
  })

  it('keeps PayPal error names and event type names', () => {
    expect((redact(fx('B_cap3').body) as any).name).toBe('UNPROCESSABLE_ENTITY')
    expect((redact({ event_types: [{ name: 'PAYMENT.CAPTURE.COMPLETED' }] }) as any).event_types[0].name).toBe('PAYMENT.CAPTURE.COMPLETED')
  })

  it('removes payer PII and tokens', () => {
    const r = redact({
      payer: { name: { given_name: 'Ann', surname: 'Lee' }, email_address: 'ann@example.com', phone: { phone_number: { national_number: '4085551234' } }, address: { country_code: 'US' } },
      access_token: 'A21AAabcdefghijklmnopqrstuvwxyz0123456789',
      Authorization: 'Bearer abc.def.ghi',
    }) as any
    expect(r.payer.name).toBe('[redacted]')
    expect(r.payer.email_address).toBe('ann***@example.com')
    expect(r.payer.phone).toBe('[redacted]')
    expect(r.payer.address).toBe('[redacted]')
    expect(r.access_token).toBe('[redacted]')
    expect(r.Authorization).toBe('[redacted]')
  })

  it('scrubs secrets hidden in free text', () => {
    expect(scrubString('Authorization: Bearer A21AAxyzxyzxyzxyzxyzxyzxyz')).not.toContain('A21AA')
    expect(scrubString('card 4111 1111 1111 1111 thanks')).toBe('card [redacted-pan] thanks')
    expect(scrubString('order 5V685566E5143111P')).toBe('order 5V685566E5143111P')
    expect(scrubString('call 4085551234')).toBe('call 4085551234')
  })

  it('masks emails', () => {
    expect(maskEmail('sb-abcd123456@personal.example.com')).toBe('sb-a***@personal.example.com')
    expect(maskEmail('ab@x.io')).toBe('ab***@x.io')
    expect(maskEmail('nope')).toBe('[redacted]')
  })

  it('keeps only safe request headers', () => {
    expect(pickHeaders({ Authorization: 'Bearer x', 'PayPal-Request-Id': 'settle-R-F', Prefer: 'return=representation', Cookie: 'c' })).toEqual({
      'paypal-request-id': 'settle-R-F',
      prefer: 'return=representation',
    })
  })
})
