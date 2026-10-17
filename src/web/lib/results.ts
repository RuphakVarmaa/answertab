// Room money totals for the Results panel. Refunds come off the net: PayPal keeps the original fee on a refund.
import type { ConsoleView } from '../../shared/types.js'
import type { ConsoleTotals } from './api.js'

export interface ResultsTotals extends ConsoleTotals {
  /** Every capture's fee is known (PayPal can omit the breakdown while a capture is PENDING). */
  feesKnown: boolean
  fromServer: boolean
}

export function resultsTotals(view: Pick<ConsoleView, 'tabs'> & { totals?: Partial<ConsoleTotals> | null }): ResultsTotals {
  const tabs = view.tabs.filter((t) => t.state !== 'opening')
  const feesKnown = tabs.every((t) => t.capturedCents === 0 || t.feeCents !== null)
  const t = view.totals
  if (t && [t.grossCents, t.feeCents, t.refundedCents, t.netCents].every((n) => typeof n === 'number' && Number.isInteger(n)))
    return { grossCents: t.grossCents!, feeCents: t.feeCents!, refundedCents: t.refundedCents!, netCents: t.netCents!, feesKnown, fromServer: true }
  const grossCents = tabs.reduce((s, x) => s + x.capturedCents, 0)
  const feeCents = tabs.reduce((s, x) => s + (x.feeCents ?? 0), 0)
  const refundedCents = tabs.reduce((s, x) => s + x.refundedCents, 0)
  return { grossCents, feeCents, refundedCents, netCents: Math.max(0, grossCents - feeCents - refundedCents), feesKnown, fromServer: false }
}
