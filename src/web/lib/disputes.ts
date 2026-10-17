// Dispute evidence packs (server: src/server/domain/disputes.ts evidencePack) read defensively for display.
import type { DisputeView } from './api.js'

const rec = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {})
const s = (x: unknown): string | null => (typeof x === 'string' && x ? x : null)
const n = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null)

export interface EvidenceLine {
  questionNumber: number | null
  question: string
  kind: string | null
  amountCents: number | null
  chargeCents: number | null
  state: string | null
  rating: string | null
  quote: string | null
  quoteAtMs: number | null
  quoteSource: string | null
  creatorConfirmed: boolean
}

export interface EvidenceSummary {
  generatedAt: string | null
  roomTitle: string | null
  streamStartedAt: string | null
  sellerResponseDue: string | null
  ids: { label: string; value: string }[]
  holdCents: number | null
  capturedCents: number | null
  refundedCents: number | null
  lines: EvidenceLine[]
  contests: { id: string; state: string | null; finding: string | null; refundId: string | null; refundCents: number | null }[]
}

export function summarizeEvidence(pack: unknown): EvidenceSummary | null {
  const p = rec(pack)
  if (Object.keys(p).length === 0) return null
  const room = rec(p.room)
  const tab = rec(p.tab)
  const dispute = rec(p.dispute)
  const ids = (
    [
      ['Dispute', dispute.id],
      ['Order', tab.orderId],
      ['Authorization', tab.authorizationId],
      ['Capture', tab.captureId],
    ] as const
  ).flatMap(([label, v]) => (s(v) ? [{ label, value: s(v)! }] : []))
  const lines = (Array.isArray(p.lines) ? p.lines : []).map((x) => {
    const l = rec(x)
    return {
      questionNumber: n(l.questionNumber),
      question: s(l.question) ?? '',
      kind: s(l.kind),
      amountCents: n(l.amountCents),
      chargeCents: n(l.chargeCents),
      state: s(l.state),
      rating: s(l.rating),
      quote: s(l.quote),
      quoteAtMs: n(l.quoteAtMs),
      quoteSource: s(l.quoteSource),
      creatorConfirmed: l.creatorConfirmed === true,
    }
  })
  const contests = (Array.isArray(p.contests) ? p.contests : []).flatMap((x) => {
    const c = rec(x)
    return s(c.id) ? [{ id: s(c.id)!, state: s(c.state), finding: s(c.finding), refundId: s(c.refundId), refundCents: n(c.refundCents) }] : []
  })
  return {
    generatedAt: s(p.generatedAt),
    roomTitle: s(room.title),
    streamStartedAt: s(room.streamStartedAt),
    sellerResponseDue: s(dispute.sellerResponseDueDate),
    ids,
    holdCents: n(tab.holdCents),
    capturedCents: n(tab.capturedCents),
    refundedCents: n(tab.refundedCents),
    lines,
    contests,
  }
}

const CLOSED = new Set(['RESOLVED', 'CLOSED'])
export function disputeIsOpen(d: Pick<DisputeView, 'status'>): boolean {
  return !CLOSED.has(String(d.status ?? '').toUpperCase())
}

/** "MERCHANDISE_OR_SERVICE_NOT_RECEIVED" -> "Merchandise or service not received". */
export function humanize(code: string | null | undefined): string {
  if (!code) return 'Unknown'
  const t = code.replace(/_/g, ' ').toLowerCase()
  return t.charAt(0).toUpperCase() + t.slice(1)
}

/** File name for the JSON download (safe characters only). */
export function evidenceFileName(d: Pick<DisputeView, 'id'>): string {
  return `answertab-evidence-${d.id.replace(/[^A-Za-z0-9_-]/g, '') || 'dispute'}.json`
}
