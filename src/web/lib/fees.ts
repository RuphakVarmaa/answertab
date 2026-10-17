// Price screen rows: PayPal's indicative fee at published rates. Display only, always labeled an estimate;
// ledger fees always come from PayPal's responses.
import type { PricesView } from '../../shared/types.js'
import { PUBLISHED_RATES, estimateFee } from '../../shared/money.js'

export interface FeeRow {
  label: string
  amountCents: number
  checkoutFeeCents: number
  cardsFeeCents: number
  platformFeeCents: number
  /** Creator keeps, worst case (Checkout rate) and best case (advanced cards rate). */
  keepLowCents: number
  keepHighCents: number
}

export function feeRows(prices: PricesView): FeeRow[] {
  const q = prices.questionCents
  const m = prices.metooCents
  const candidates: { label: string; amountCents: number }[] = [
    { label: 'One me-too', amountCents: m },
    { label: 'One question', amountCents: q },
    { label: 'Question + me-too', amountCents: q + m },
    { label: 'Two questions', amountCents: 2 * q },
    ...prices.ceilingsCents.map((c) => ({ label: 'Full hold', amountCents: c })),
  ]
  const seen = new Set<number>()
  return candidates
    .filter((c) => c.amountCents > 0 && !seen.has(c.amountCents) && (seen.add(c.amountCents), true))
    .sort((a, b) => a.amountCents - b.amountCents)
    .map(({ label, amountCents }) => {
      const checkoutFeeCents = estimateFee(amountCents, PUBLISHED_RATES.checkout)
      const cardsFeeCents = estimateFee(amountCents, PUBLISHED_RATES.advancedCards)
      const platformFeeCents = Math.floor((amountCents * prices.platformFeeBps) / 10_000)
      return {
        label,
        amountCents,
        checkoutFeeCents,
        cardsFeeCents,
        platformFeeCents,
        keepLowCents: Math.max(0, amountCents - Math.max(checkoutFeeCents, cardsFeeCents) - platformFeeCents),
        keepHighCents: Math.max(0, amountCents - Math.min(checkoutFeeCents, cardsFeeCents) - platformFeeCents),
      }
    })
}

export function rateLabel(rate: { bps: number; fixedCents: number }): string {
  return `${(rate.bps / 100).toFixed(2)}% + $${(rate.fixedCents / 100).toFixed(2)}`
}
