// Pure policy gate for contest refunds. The model only reports a finding; code decides what happens.
import type { ContestFinding } from '../../shared/types.js'

/** The desk may refund on its own up to this share, and only for these findings. */
export const AUTO_REFUND_MAX_CENTS = 500
export const AUTO_REFUND_FINDINGS: ReadonlySet<ContestFinding> = new Set(['not_answered', 'deferred'])

export type RefundPolicyDecision =
  | { action: 'auto_refund'; amountCents: number; reason: string }
  | { action: 'pending_creator'; amountCents: number; reason: string }
  | { action: 'nothing_to_refund'; amountCents: 0; reason: string }

export function refundPolicy(p: { finding: ContestFinding; shareCents: number }): RefundPolicyDecision {
  if (!Number.isSafeInteger(p.shareCents) || p.shareCents < 0) throw new Error(`bad share ${p.shareCents}`)
  if (p.shareCents === 0) return { action: 'nothing_to_refund', amountCents: 0, reason: 'nothing left to refund on this backing' }
  if (p.finding === 'answered') return { action: 'pending_creator', amountCents: p.shareCents, reason: 'finding is answered; a refund needs the creator' }
  if (!AUTO_REFUND_FINDINGS.has(p.finding)) {
    return { action: 'pending_creator', amountCents: p.shareCents, reason: `finding ${p.finding} needs the creator's approval` }
  }
  if (p.shareCents > AUTO_REFUND_MAX_CENTS) {
    return { action: 'pending_creator', amountCents: p.shareCents, reason: `share is over the automatic limit of ${AUTO_REFUND_MAX_CENTS} cents` }
  }
  return { action: 'auto_refund', amountCents: p.shareCents, reason: `finding ${p.finding}, share within the automatic limit` }
}
