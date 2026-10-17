// Disputes v1 read through the Agent Toolkit's get_dispute (used on CUSTOMER.DISPUTE.* webhooks).
import { parseAmount } from '../../shared/money.js'
import type { LedgerContext } from './ledger.js'
import { redact } from './redact.js'
import { toolkitCall } from './toolkit.js'

type Obj = Record<string, any>

export interface ParsedDispute {
  disputeId: string
  status: string
  reason: string | null
  stage: string | null
  amountCents: number | null
  /** seller_transaction_id is the capture id; that is how a dispute maps to a tab. */
  disputedTransactions: { sellerTransactionId: string | null; buyerTransactionId: string | null; invoiceNumber: string | null }[]
  sellerResponseDueDate: string | null
}

export function parseDispute(raw: unknown): ParsedDispute {
  const d = (raw ?? {}) as Obj
  let amountCents: number | null = null
  try {
    amountCents = typeof d.dispute_amount?.value === 'string' ? parseAmount(d.dispute_amount.value) : null
  } catch {
    amountCents = null
  }
  return {
    disputeId: String(d.dispute_id ?? ''),
    status: String(d.status ?? ''),
    reason: d.reason ?? null,
    stage: d.dispute_life_cycle_stage ?? null,
    amountCents,
    disputedTransactions: ((d.disputed_transactions ?? []) as Obj[]).map((t) => ({
      sellerTransactionId: t.seller_transaction_id ?? null,
      buyerTransactionId: t.buyer_transaction_id ?? null,
      invoiceNumber: t.invoice_number ?? null,
    })),
    sellerResponseDueDate: d.seller_response_due_date ?? null,
  }
}

export async function getDispute(id: string, ctx?: LedgerContext): Promise<ParsedDispute & { raw: unknown }> {
  const res = await toolkitCall(
    { op: 'disputes.get:toolkit', tool: 'get_dispute', ctx, resource: (b) => ({ id: b?.dispute_id ?? null, status: b?.status ?? null }) },
    { dispute_id: id },
  )
  return { ...parseDispute(res.body), raw: redact(res.body) }
}
