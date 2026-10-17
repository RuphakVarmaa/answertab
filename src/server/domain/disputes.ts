// Disputes: CUSTOMER.DISPUTE.* webhooks are read back with the Agent Toolkit's get_dispute, mapped to a tab by the
// disputed capture id, and stored with an evidence pack for the creator console. Refunds wait while one is open.
import { db } from '../db/db.js'
import { getDispute } from '../paypal/index.js'
import { iso, nowDate } from './clock.js'
import type { ContestRow, QuestionRow, RoomRow, TabRow } from './rows.js'
import { emitTab } from './views.js'

export interface DisputeView {
  id: string
  tabId: string | null
  status: string | null
  reason: string | null
  amountCents: number | null
  evidencePack: unknown
  updatedAt: string | null
}

interface DisputeRow {
  id: string
  tab_id: string | null
  room_id: string | null
  status: string | null
  reason: string | null
  amount_cents: number | null
  evidence_pack: unknown
  updated_at: Date | string
}

const CLOSED = new Set(['RESOLVED', 'CLOSED'])

export async function hasOpenDispute(tabId: string): Promise<boolean> {
  const rows = await db().query<{ status: string | null }>(`SELECT status FROM disputes WHERE tab_id = $1`, [tabId])
  return rows.some((r) => !CLOSED.has(String(r.status ?? '').toUpperCase()))
}

export async function listDisputes(roomId: string): Promise<DisputeView[]> {
  const rows = await db().query<DisputeRow>(`SELECT * FROM disputes WHERE room_id = $1 ORDER BY created_at`, [roomId])
  return rows.map((d) => ({
    id: d.id,
    tabId: d.tab_id,
    status: d.status,
    reason: d.reason,
    amountCents: d.amount_cents,
    evidencePack: d.evidence_pack,
    updatedAt: iso(d.updated_at),
  }))
}

/** The receipt as evidence: question, quote, timestamps, capture id and contest history for one tab. */
export async function evidencePack(tabId: string): Promise<Record<string, unknown>> {
  const [tab] = await db().query<TabRow>(`SELECT * FROM tabs WHERE id = $1`, [tabId])
  if (!tab) return {}
  const [room] = await db().query<RoomRow>(`SELECT * FROM rooms WHERE id = $1`, [tab.room_id])
  const lines = await db().query<QuestionRow & { kind: string; amount_cents: number; charge_cents: number | null; backed_at_ms: number; backing_state: string }>(
    `SELECT q.*, b.kind, b.amount_cents, b.charge_cents, b.backed_at_ms, b.state AS backing_state
     FROM backings b JOIN questions q ON q.id = b.question_id WHERE b.tab_id = $1 ORDER BY q.number`,
    [tabId],
  )
  const contests = await db().query<ContestRow>(`SELECT * FROM contests WHERE tab_id = $1 ORDER BY created_at`, [tabId])
  return {
    generatedAt: nowDate().toISOString(),
    room: { id: room?.id, title: room?.title, streamStartedAt: iso(room?.clock_started_at ?? null), endedAt: iso(room?.ended_at ?? null) },
    tab: {
      id: tab.id, orderId: tab.order_id, authorizationId: tab.authorization_id, captureId: tab.capture_id,
      holdCents: tab.ceiling_cents, capturedCents: tab.captured_cents, releasedCents: tab.released_cents, refundedCents: tab.refunded_cents,
      settledAt: iso(tab.settled_at),
    },
    lines: lines.map((l) => ({
      questionNumber: l.number, question: l.text, askedAtMs: l.asked_at_ms, kind: l.kind, backedAtMs: l.backed_at_ms,
      amountCents: l.amount_cents, chargeCents: l.charge_cents, state: l.backing_state, rating: l.rating,
      quote: l.quote, quoteAtMs: l.quote_at_ms, answerStartMs: l.answer_start_ms, quoteSource: l.quote_source,
      creatorConfirmed: l.creator_confirmed, verifier: l.verifier,
    })),
    contests: contests.map((c) => ({
      id: c.id, backingId: c.backing_id, state: c.state, finding: c.finding, evidence: c.evidence, explanation: c.explanation,
      refundId: c.refund_id, refundCents: c.refund_cents, createdAt: iso(c.created_at), decidedAt: iso(c.decided_at),
    })),
  }
}

/** Reads the dispute live and stores it against the disputed tab. Returns the tab id, if any matched. */
export async function syncDispute(disputeId: string): Promise<string | null> {
  const d = await getDispute(disputeId)
  const captureIds = d.disputedTransactions.map((t) => t.sellerTransactionId).filter((x): x is string => !!x)
  const [tab] = captureIds.length
    ? await db().query<TabRow>(`SELECT * FROM tabs WHERE capture_id = ANY($1::text[]) LIMIT 1`, [captureIds])
    : []
  const pack = tab ? { dispute: { id: d.disputeId, status: d.status, reason: d.reason, stage: d.stage, amountCents: d.amountCents, sellerResponseDueDate: d.sellerResponseDueDate }, ...(await evidencePack(tab.id)) } : null
  await db().query(
    `INSERT INTO disputes (id, tab_id, room_id, status, reason, amount_cents, evidence_pack, raw, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)
     ON CONFLICT (id) DO UPDATE SET tab_id = COALESCE(EXCLUDED.tab_id, disputes.tab_id), room_id = COALESCE(EXCLUDED.room_id, disputes.room_id),
       status = EXCLUDED.status, reason = EXCLUDED.reason, amount_cents = EXCLUDED.amount_cents,
       evidence_pack = COALESCE(EXCLUDED.evidence_pack, disputes.evidence_pack), raw = EXCLUDED.raw, updated_at = EXCLUDED.updated_at`,
    [d.disputeId || disputeId, tab?.id ?? null, tab?.room_id ?? null, d.status || null, d.reason, d.amountCents, pack ? JSON.stringify(pack) : null, JSON.stringify(d.raw ?? null), nowDate()],
  )
  if (tab) await emitTab(tab.id)
  return tab?.id ?? null
}
