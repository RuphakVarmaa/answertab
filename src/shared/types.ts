// Shared API and event shapes. Server and web both import from here.
// Amounts are integer cents. Times on the room clock are ms since rooms.clock_started_at.

export type RoomKind = 'demo' | 'public'
export type BudgetPool = 'judge' | 'public'
export type RoomStatus = 'draft' | 'live' | 'ended' | 'settling' | 'settled' | 'voided'
export type Funding = 'card' | 'paypal' | 'bot_card'
export type TabState = 'opening' | 'held' | 'declined' | 'settling' | 'captured' | 'voided' | 'failed'
export type AuthStatus = 'CREATED' | 'CAPTURED' | 'DENIED' | 'PARTIALLY_CAPTURED' | 'VOIDED' | 'EXPIRED' | 'PENDING'
export type QuestionState = 'open' | 'hidden' | 'deflected' | 'verifying' | 'locked' | 'review' | 'approved' | 'unpaid'
export type Rating = 'full' | 'half' | 'none'
export type SegmentSource = 'spoken' | 'typed' | 'replay'
export type BackingKind = 'ask' | 'metoo'
export type BackingState = 'reserved' | 'released' | 'charged' | 'refunded'
export type VerdictKind = 'answered' | 'partial' | 'deflected' | 'already_covered' | 'not_yet'
export type ContestState = 'open' | 'deciding' | 'refunded' | 'pending_creator' | 'upheld' | 'failed'
export type ContestFinding = 'not_answered' | 'deferred' | 'partially_answered' | 'answered'
export type PayoutState = 'none' | 'pending' | 'success' | 'denied' | 'unclaimed' | 'failed'
export type AiMode = 'ai' | 'manual'

/** Inclusive evidence span over segment seq numbers and word indexes. */
export interface EvidenceSpan {
  startSeg: number
  startWord: number
  endSeg: number
  endWord: number
}

export interface Segment {
  seq: number
  text: string
  words: string[]
  tStartMs: number
  tEndMs: number
  source: SegmentSource
  final: boolean
}

export interface Verdict {
  questionNumber: number
  verdict: VerdictKind
  evidence: EvidenceSpan | null
  confidence: number
}

export interface PricesView {
  questionCents: number
  metooCents: number
  ceilingsCents: number[]
  platformFeeBps: number
}

export interface RoomView {
  id: string
  title: string
  kind: RoomKind
  status: RoomStatus
  prices: PricesView
  language: string
  aiMode: AiMode
  clockStartedAt: string | null
  endedAt: string | null
  contestWindowEndsAt: string | null
  payoutState: PayoutState
  questions: QuestionView[]
}

export interface QuestionView {
  id: string
  number: number
  text: string
  askerName: string
  state: QuestionState
  backers: number
  backedCents: number
  similarTo: number | null
  askedAtMs: number
  quote: string | null
  quoteAtMs: number | null
  quoteSource: SegmentSource | null
  creatorConfirmed: boolean
  confidence: number | null
  rating: Rating | null
  /** The quote stops before the end of its transcript segment (show it with a trailing ellipsis). */
  quoteTruncated?: boolean
}

export interface TabView {
  id: string
  fanId: string
  ceilingCents: number
  reservedCents: number
  funding: Funding
  state: TabState
  authStatus: AuthStatus | null
  orderId: string | null
  authorizationId: string | null
  captureId: string | null
  capturedCents: number
  releasedCents: number
  feeCents: number | null
  refundedCents: number
  receiptToken: string | null
  declineReason: string | null
  /** When a verified PayPal webhook first confirmed the completed capture (a badge only; nothing waits on it). */
  captureWebhookAt?: string | null
}

export interface BackingView {
  id: string
  questionId: string
  questionNumber: number
  kind: BackingKind
  amountCents: number
  chargeCents: number | null
  state: BackingState
  /** Room clock time the fan backed (or asked). */
  backedAtMs?: number
  /** null until the card has an answer; false when the fan backed after the answer started (never charged). */
  chargeable?: boolean | null
}

export interface FanSelfView {
  fanId: string
  displayName: string
  tab: TabView | null
  backings: BackingView[]
}

export interface LedgerCallView {
  id: string
  at: string
  op: string
  method: string
  endpoint: string
  requestId: string | null
  httpStatus: number
  resourceId: string | null
  resourceStatus: string | null
  debugId: string | null
  latencyMs: number
  tabId: string | null
}

export interface ConsoleView {
  room: RoomView
  segments: Segment[]
  tabs: (TabView & { displayName: string; isBot: boolean })[]
  ledger: LedgerCallView[]
  contests: ContestView[]
  payout: PayoutView | null
  llmSpentMicros: number
  /** Verified PayPal webhook events for this room's PayPal resources, newest first, at most 50. */
  webhooks?: WebhookEventView[]
  /** From PayPal's numbers after settlement. */
  totals?: { grossCents: number; feeCents: number; refundedCents: number; netCents: number } | null
}

export interface WebhookEventView {
  id: string
  eventType: string
  resourceId: string | null
  receivedAt: string
  verified: boolean
}

export type ReceiptLineStatus = 'reserved' | 'charged' | 'released' | 'refunded'

export interface ReceiptLine {
  backingId: string
  questionNumber: number
  questionText: string
  kind: BackingKind
  amountCents: number
  /** null until the tab is settled (captured, voided or failed). */
  chargeCents: number | null
  status?: ReceiptLineStatus
  rating: Rating | null
  quote: string | null
  quoteAtMs: number | null
  quoteSource: SegmentSource | null
  creatorConfirmed: boolean
  /** Set with quote: the quote stops before the end of its transcript segment. */
  quoteTruncated?: boolean
  contest: ContestView | null
}

export interface ReceiptView {
  roomTitle: string
  fanName: string
  tab: TabView
  lines: ReceiptLine[]
  contestDeadline: string | null
  verifiedAt: string | null
}

export interface ContestView {
  id: string
  backingId: string
  state: ContestState
  finding: ContestFinding | null
  explanation: string | null
  refundId: string | null
  refundCents: number | null
  progress: string[]
  createdAt: string
  /** When a verified PayPal webhook first confirmed the refund (a badge only). */
  refundWebhookAt?: string | null
}

export interface PayoutView {
  state: PayoutState
  amountCents: number
  feeCents: number | null
  payoutBatchId: string | null
  batchStatus: string | null
  webhookSeen: boolean
}

export interface ReviewItem {
  /** false for a card that locked after End: charged only when the creator rates it. */
  chargedByDefault?: boolean
  questionNumber: number
  questionId: string
  text: string
  state: QuestionState
  quote: string | null
  /** The quote stops before the end of its transcript segment. */
  quoteTruncated?: boolean
  confidence: number | null
  verdict: VerdictKind | null
  backers: number
  lockedCents: number
}

export interface PublicConfig {
  paypalClientId: string
  environment: 'sandbox'
  testCard: { number: string; expiry: string; cvv: string; name: string }
  aiEnabled: boolean
  judgeModeAvailable: boolean
}

export interface StatusCheck {
  name: string
  ok: boolean
  detail: string
  checkedAt: string
}

export type RoomEvent =
  | { type: 'room.state'; room: RoomView }
  | { type: 'question.created'; question: QuestionView }
  | { type: 'question.updated'; question: QuestionView }
  | { type: 'backing.created'; questionId: string; backers: number; backedCents: number }
  | { type: 'tab.updated'; tab: TabView & { displayName?: string; isBot?: boolean } }
  | { type: 'segment.added'; segment: Segment }
  | { type: 'segment.interim'; text: string }
  | { type: 'verdict'; questionNumber: number; action: 'lock' | 'review' | 'deflected' | 'verifying' | 'ignore'; quote: string | null; reason: string }
  | { type: 'settle.progress'; done: number; total: number }
  | { type: 'ledger.call'; call: LedgerCallView }
  | { type: 'contest.updated'; contest: ContestView }
  | { type: 'payout.updated'; payout: PayoutView }
  | { type: 'budget.mode'; mode: AiMode; reason: string }

export interface ApiError {
  error: { code: string; message: string }
}
