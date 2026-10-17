// DB row shapes (snake_case, as both pg and PGlite return them) and their API views.
import type {
  AiMode,
  AuthStatus,
  BackingKind,
  BackingState,
  BackingView,
  BudgetPool,
  ContestFinding,
  ContestState,
  ContestView,
  EvidenceSpan,
  Funding,
  PayoutState,
  PayoutView,
  QuestionState,
  QuestionView,
  Rating,
  RoomKind,
  RoomStatus,
  RoomView,
  Segment,
  SegmentSource,
  TabState,
  TabView,
  VerdictKind,
} from '../../shared/types.js'
import { iso } from './clock.js'

type Ts = Date | string

export interface RoomRow {
  id: string
  creator_token_hash: string
  title: string
  kind: RoomKind
  pool: BudgetPool
  question_price_cents: number
  metoo_price_cents: number
  ceilings_cents: number[]
  platform_fee_bps: number
  language: string
  status: RoomStatus
  ai_mode: AiMode
  ai_mode_reason: string | null
  clock_started_at: Ts | null
  ended_at: Ts | null
  approve_deadline: Ts | null
  contest_window_ends_at: Ts | null
  payout_state: PayoutState
  llm_spent_micros: number | string
  created_ip_hash: string | null
  created_at: Ts
  expires_at: Ts
}

export interface FanRow {
  id: string
  room_id: string
  display_name: string
  fan_token: string
  is_bot: boolean
  created_at: Ts
}

export interface TabRow {
  id: string
  room_id: string
  fan_id: string
  ceiling_cents: number
  funding: Funding
  order_id: string | null
  authorization_id: string | null
  auth_status: string | null
  auth_expires_at: Ts | null
  state: TabState
  decline_reason: string | null
  capture_id: string | null
  capture_status: string | null
  captured_cents: number
  fee_cents: number | null
  net_cents: number | null
  released_cents: number
  refunded_cents: number
  receipt_token: string | null
  settle_attempt: number
  /** Bumped when a tab without an authorization is re-ordered (new size or payment method). */
  order_attempt: number
  settled_at: Ts | null
  /** First verified PayPal webhook confirming the completed capture (badge only). */
  capture_webhook_at?: Ts | null
  created_at: Ts
}

/** A tab joined with its fan and its active reservations. */
export interface TabJoined extends TabRow {
  display_name: string
  is_bot: boolean
  reserved_cents: number
}

export interface QuestionRow {
  id: string
  room_id: string
  number: number
  asker_fan_id: string
  text: string
  clean_text: string
  cues: string[]
  similar_to: number | null
  state: QuestionState
  asked_at_ms: number
  verdict: string | null
  confidence: number | null
  span: EvidenceSpan | null
  quote: string | null
  quote_at_ms: number | null
  answer_start_ms: number | null
  quote_source: SegmentSource | null
  creator_confirmed: boolean
  verifier: unknown
  rating: Rating | null
  /** Snapshot at End: the card was already locked when the creator clicked End. */
  locked_at_end: boolean
  /** The stored quote stops before the end of its last segment. */
  quote_truncated?: boolean
  updated_at: Ts
  created_at: Ts
}

export interface QuestionJoined extends QuestionRow {
  asker_name: string
  backers: number
  backed_cents: number
}

export interface BackingRow {
  id: string
  question_id: string
  room_id: string
  fan_id: string
  tab_id: string
  kind: BackingKind
  amount_cents: number
  backed_at_ms: number
  charge_cents: number | null
  state: BackingState
  refunded_cents: number
  created_at: Ts
}

export interface SegmentRow {
  id: string
  room_id: string
  seq: number
  text: string
  words: string[]
  t_start_ms: number
  t_end_ms: number
  source: SegmentSource
  final: boolean
}

export interface ContestRow {
  id: string
  room_id: string
  tab_id: string
  backing_id: string
  reason: string
  state: ContestState
  finding: ContestFinding | null
  evidence: string | null
  explanation: string | null
  refund_id: string | null
  refund_cents: number | null
  messages: unknown[]
  progress: string[]
  created_at: Ts
  decided_at: Ts | null
  /** First verified PayPal webhook confirming the refund (badge only). */
  refund_webhook_at?: Ts | null
}

export interface PayoutRow {
  id: string
  room_id: string
  attempt: number
  sender_batch_id: string
  payout_batch_id: string | null
  receiver: string
  amount_cents: number
  platform_fee_cents: number
  fee_cents: number | null
  batch_status: string | null
  item_status: string | null
  webhook_seen: boolean
  created_at: Ts
  updated_at: Ts
}

export const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v))

export const QUESTION_SELECT = `
SELECT q.*, f.display_name AS asker_name,
  COALESCE(b.backers, 0)::int AS backers, COALESCE(b.backed_cents, 0)::int AS backed_cents
FROM questions q
JOIN fans f ON f.id = q.asker_fan_id
LEFT JOIN (
  SELECT question_id, count(*)::int AS backers, COALESCE(sum(amount_cents), 0)::int AS backed_cents
  FROM backings WHERE state <> 'released' GROUP BY question_id
) b ON b.question_id = q.id`

export const TAB_SELECT = `
SELECT t.*, f.display_name, f.is_bot,
  COALESCE((SELECT sum(b.amount_cents) FROM backings b WHERE b.tab_id = t.id AND b.state = 'reserved'), 0)::int AS reserved_cents
FROM tabs t JOIN fans f ON f.id = t.fan_id`

export function questionView(q: QuestionJoined): QuestionView {
  return {
    id: q.id,
    number: q.number,
    text: q.text,
    askerName: q.asker_name,
    state: q.state,
    backers: num(q.backers),
    backedCents: num(q.backed_cents),
    similarTo: q.similar_to,
    askedAtMs: q.asked_at_ms,
    quote: q.quote,
    quoteAtMs: q.quote_at_ms,
    quoteSource: q.quote_source,
    creatorConfirmed: q.creator_confirmed,
    confidence: q.confidence === null ? null : Number(q.confidence),
    rating: q.rating,
    quoteTruncated: q.quote !== null && q.quote_truncated === true,
  }
}

/** What non-creators see of a hidden card: that it is gone, not what it said. */
export function redactHidden(v: QuestionView): QuestionView {
  return v.state === 'hidden' ? { ...v, text: '', askerName: '', quote: null } : v
}

const AUTH: readonly string[] = ['CREATED', 'CAPTURED', 'DENIED', 'PARTIALLY_CAPTURED', 'VOIDED', 'EXPIRED', 'PENDING']

export function tabView(t: TabRow & { reserved_cents?: number }): TabView {
  return {
    id: t.id,
    fanId: t.fan_id,
    ceilingCents: t.ceiling_cents,
    reservedCents: num(t.reserved_cents),
    funding: t.funding,
    state: t.state,
    authStatus: t.auth_status && AUTH.includes(t.auth_status) ? (t.auth_status as AuthStatus) : null,
    orderId: t.order_id,
    authorizationId: t.authorization_id,
    captureId: t.capture_id,
    capturedCents: t.captured_cents,
    releasedCents: t.released_cents,
    feeCents: t.fee_cents,
    refundedCents: t.refunded_cents,
    receiptToken: t.receipt_token,
    declineReason: t.decline_reason,
    captureWebhookAt: iso(t.capture_webhook_at ?? null),
  }
}

/** The creator sees every tab, but a real fan's receipt token stays private to that fan (bots' links are shown). */
export function creatorTabView(t: TabJoined): TabView & { displayName: string; isBot: boolean } {
  return { ...tabView(t), receiptToken: t.is_bot ? t.receipt_token : null, displayName: t.display_name, isBot: t.is_bot }
}

export function backingView(b: BackingRow & { question_number: number; answer_start_ms?: number | null }): BackingView {
  const answerStart = b.answer_start_ms ?? null
  return {
    id: b.id,
    questionId: b.question_id,
    questionNumber: b.question_number,
    kind: b.kind,
    amountCents: b.amount_cents,
    chargeCents: b.charge_cents,
    state: b.state,
    backedAtMs: b.backed_at_ms,
    // Same rule as money.chargeForBacking: a backer who joined after the answer started is never charged.
    chargeable: answerStart === null ? null : b.backed_at_ms <= answerStart,
  }
}

export function segmentView(s: SegmentRow): Segment {
  return { seq: s.seq, text: s.text, words: s.words, tStartMs: s.t_start_ms, tEndMs: s.t_end_ms, source: s.source, final: s.final }
}

export function contestView(c: ContestRow): ContestView {
  return {
    id: c.id,
    backingId: c.backing_id,
    state: c.state,
    finding: c.finding,
    explanation: c.explanation,
    refundId: c.refund_id,
    refundCents: c.refund_cents,
    progress: Array.isArray(c.progress) ? c.progress : [],
    createdAt: iso(c.created_at) ?? '',
    refundWebhookAt: iso(c.refund_webhook_at ?? null),
  }
}

/** checkedAt: when the payout row last changed (each poll writes it), for "last checked" in the console. */
export function payoutView(room: Pick<RoomRow, 'payout_state'>, p: PayoutRow | null): (PayoutView & { checkedAt: string | null }) | null {
  if (!p) return null
  return {
    state: room.payout_state,
    amountCents: p.amount_cents,
    feeCents: p.fee_cents,
    payoutBatchId: p.payout_batch_id,
    batchStatus: p.batch_status,
    webhookSeen: p.webhook_seen,
    checkedAt: iso(p.updated_at),
  }
}

export function roomView(r: RoomRow, questions: QuestionView[]): RoomView {
  return {
    id: r.id,
    title: r.title,
    kind: r.kind,
    status: r.status,
    prices: {
      questionCents: r.question_price_cents,
      metooCents: r.metoo_price_cents,
      ceilingsCents: Array.isArray(r.ceilings_cents) ? r.ceilings_cents.map(Number) : [1000, 2000, 4000],
      platformFeeBps: r.platform_fee_bps,
    },
    language: r.language,
    aiMode: r.ai_mode,
    clockStartedAt: iso(r.clock_started_at),
    endedAt: iso(r.ended_at),
    contestWindowEndsAt: iso(r.contest_window_ends_at),
    payoutState: r.payout_state,
    questions,
  }
}

export function isVerdictKind(v: string | null): v is VerdictKind {
  return v === 'answered' || v === 'partial' || v === 'deflected' || v === 'already_covered' || v === 'not_yet'
}
