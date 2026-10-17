import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  canReserve,
  chargeForBacking,
  formatCents,
  parseAmount,
  payoutAmount,
  refundShare,
  settleAction,
  tabTotal,
  toAmount,
} from '../src/shared/money.js'

const cents = fc.integer({ min: 0, max: 1_000_000 })
const rating = fc.constantFrom('full' as const, 'half' as const, 'none' as const, null)

describe('money', () => {
  it('round-trips PayPal amount strings', () => {
    fc.assert(fc.property(cents, (c) => parseAmount(toAmount(c)) === c))
    expect(toAmount(1205)).toBe('12.05')
    expect(parseAmount('6')).toBe(600)
    expect(parseAmount('0.5')).toBe(50)
    expect(() => parseAmount('1.234')).toThrow()
    expect(() => parseAmount('-1.00')).toThrow()
    expect(formatCents(600)).toBe('$6.00')
  })

  it('never charges more than the backing amount, and halves round down', () => {
    fc.assert(
      fc.property(cents, rating, fc.integer({ min: 0, max: 10_000 }), fc.integer({ min: 0, max: 10_000 }), (a, r, backed, start) => {
        const c = chargeForBacking({ amountCents: a, rating: r, backedAtMs: backed, answerStartMs: start })
        expect(c).toBeGreaterThanOrEqual(0)
        expect(c).toBeLessThanOrEqual(a)
        if (r === 'half' && backed <= start) expect(c).toBe(Math.floor(a / 2))
        if (r === null || r === 'none' || backed > start) expect(c).toBe(0)
      }),
    )
  })

  it('late backers are never charged', () => {
    expect(chargeForBacking({ amountCents: 300, rating: 'full', backedAtMs: 5001, answerStartMs: 5000 })).toBe(0)
    expect(chargeForBacking({ amountCents: 300, rating: 'full', backedAtMs: 5000, answerStartMs: 5000 })).toBe(300)
    expect(chargeForBacking({ amountCents: 300, rating: 'full', backedAtMs: 1, answerStartMs: null })).toBe(0)
  })

  it('tab total never exceeds the hold', () => {
    fc.assert(
      fc.property(fc.array(cents, { maxLength: 30 }), cents, (charges, auth) => {
        const t = tabTotal(charges, auth)
        expect(t).toBeLessThanOrEqual(auth)
        expect(t).toBeLessThanOrEqual(charges.reduce((a, b) => a + b, 0))
        expect(Number.isInteger(t)).toBe(true)
      }),
    )
  })

  it('settles by capture when there is something to charge, otherwise void', () => {
    expect(settleAction(0)).toEqual({ kind: 'void' })
    expect(settleAction(600)).toEqual({ kind: 'capture', amountCents: 600 })
  })

  it('reservations respect the ceiling', () => {
    fc.assert(
      fc.property(cents, cents, cents, (ceil, res, add) => {
        expect(canReserve(ceil, res, add)).toBe(res + add <= ceil)
      }),
    )
  })

  it('refunds never exceed what is still refundable', () => {
    fc.assert(
      fc.property(cents, cents, cents, (charge, captured, refunded) => {
        const r = refundShare(charge, captured, refunded)
        expect(r).toBeGreaterThanOrEqual(0)
        expect(r).toBeLessThanOrEqual(charge)
        expect(r + refunded).toBeLessThanOrEqual(Math.max(captured, refunded))
      }),
    )
  })

  it('payout is never negative and takes the platform fee from gross', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(cents, fc.integer({ min: 0, max: 100 })), { maxLength: 10 }),
        fc.array(cents, { maxLength: 5 }),
        fc.integer({ min: 0, max: 10_000 }),
        (caps, refunds, bps) => {
          const gross = caps.map(([g]) => g)
          const net = caps.map(([g, fee]) => Math.max(0, g - fee))
          const { amountCents, platformFeeCents } = payoutAmount({ captureGrossCents: gross, captureNetCents: net, refundNetCents: refunds, platformFeeBps: bps })
          expect(amountCents).toBeGreaterThanOrEqual(0)
          expect(platformFeeCents).toBe(Math.floor((gross.reduce((a, b) => a + b, 0) * bps) / 10_000))
        },
      ),
    )
    expect(
      payoutAmount({ captureGrossCents: [600, 300, 600], captureNetCents: [535, 243, 535], refundNetCents: [300], platformFeeBps: 500 }),
    ).toEqual({ amountCents: 535 + 243 + 535 - 300 - 75, platformFeeCents: 75 })
  })
})
