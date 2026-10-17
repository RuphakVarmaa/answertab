// Pure money rules. Integer cents only. Property-tested in test/money.test.ts.
import type { Rating } from './types.js'

export function assertCents(n: number, label = 'amount'): void {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${label} must be a non-negative integer number of cents, got ${n}`)
}

/** "$12.00" style. */
export function formatCents(cents: number, currency = 'USD'): string {
  assertCents(Math.abs(cents))
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const symbol = currency === 'USD' ? '$' : `${currency} `
  return `${sign}${symbol}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

/** PayPal amount string "12.34" -> 1234. Rejects anything that is not a plain decimal with at most 2 places. */
export function parseAmount(value: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) throw new Error(`not a PayPal amount: ${value}`)
  const [whole, frac = ''] = value.split('.')
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'))
}

/** 1234 -> "12.34" for PayPal requests. */
export function toAmount(cents: number): string {
  assertCents(cents)
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`
}

/** Can a fan reserve `addCents` more on a tab with `ceilingCents`, given current active reservations? */
export function canReserve(ceilingCents: number, reservedCents: number, addCents: number): boolean {
  assertCents(ceilingCents, 'ceiling')
  assertCents(reservedCents, 'reserved')
  assertCents(addCents, 'add')
  return reservedCents + addCents <= ceilingCents
}

/**
 * What one backing costs the fan after the creator's rating.
 * - unapproved (rating null) or 'none' -> 0
 * - 'half' -> floor(amount / 2), so halves round in the fan's favor
 * - a backer who joined after the answer started is never charged
 */
export function chargeForBacking(p: {
  amountCents: number
  rating: Rating | null
  backedAtMs: number
  answerStartMs: number | null
}): number {
  assertCents(p.amountCents)
  if (p.rating === null || p.rating === 'none') return 0
  if (p.answerStartMs === null) return 0
  if (p.backedAtMs > p.answerStartMs) return 0
  return p.rating === 'full' ? p.amountCents : Math.floor(p.amountCents / 2)
}

/** Sum of a fan's charges, clamped to the authorized amount. */
export function tabTotal(chargesCents: number[], authorizedCents: number): number {
  assertCents(authorizedCents, 'authorized')
  let sum = 0
  for (const c of chargesCents) {
    assertCents(c, 'charge')
    sum += c
  }
  return Math.min(sum, authorizedCents)
}

export type SettleAction = { kind: 'capture'; amountCents: number } | { kind: 'void' }

export function settleAction(totalCents: number): SettleAction {
  assertCents(totalCents, 'total')
  return totalCents > 0 ? { kind: 'capture', amountCents: totalCents } : { kind: 'void' }
}

/** Refund for a contested backing, never more than is still refundable on the capture. */
export function refundShare(backingChargeCents: number, capturedCents: number, refundedCents: number): number {
  assertCents(backingChargeCents, 'charge')
  assertCents(capturedCents, 'captured')
  assertCents(refundedCents, 'refunded')
  const refundable = Math.max(0, capturedCents - refundedCents)
  return Math.min(backingChargeCents, refundable)
}

/**
 * Creator payout from PayPal's own numbers.
 * captureNets: seller_receivable_breakdown.net_amount per capture.
 * refundNets: seller_payable_breakdown.net_amount per refund (PayPal keeps the original fee, so this is ~ the gross refunded).
 * platform fee: bps of total captured gross, rounded down.
 */
export function payoutAmount(p: {
  captureGrossCents: number[]
  captureNetCents: number[]
  refundNetCents: number[]
  platformFeeBps: number
}): { amountCents: number; platformFeeCents: number } {
  if (!Number.isInteger(p.platformFeeBps) || p.platformFeeBps < 0 || p.platformFeeBps > 10_000) {
    throw new Error(`bad platform fee bps: ${p.platformFeeBps}`)
  }
  const gross = p.captureGrossCents.reduce((a, c) => (assertCents(c), a + c), 0)
  const net = p.captureNetCents.reduce((a, c) => (assertCents(c), a + c), 0)
  const refunds = p.refundNetCents.reduce((a, c) => (assertCents(c), a + c), 0)
  const platformFeeCents = Math.floor((gross * p.platformFeeBps) / 10_000)
  return { amountCents: Math.max(0, net - refunds - platformFeeCents), platformFeeCents }
}

/**
 * Indicative fee at PayPal's published US rates (page updated 2026-10-01). Shown on the price screen only,
 * always labeled as an estimate. Ledger fees always come from PayPal responses.
 */
export const PUBLISHED_RATES = {
  checkout: { bps: 349, fixedCents: 49 },
  advancedCards: { bps: 289, fixedCents: 29 },
} as const

export function estimateFee(amountCents: number, rate: { bps: number; fixedCents: number }): number {
  assertCents(amountCents)
  if (amountCents === 0) return 0
  return Math.round((amountCents * rate.bps) / 10_000) + rate.fixedCents
}
