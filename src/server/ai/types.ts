// Types owned by the AI layer. Shared API shapes stay in src/shared/types.ts.
import type { ContestFinding, EvidenceSpan } from '../../shared/types.js'

/** An open question as the AI layer sees it. Domain code builds these from `questions` + `backings`. */
export interface OpenQ {
  number: number
  /** Cleaned text from intake (falls back to the raw text). Untrusted. */
  text: string
  /** Room clock ms when the question was asked. */
  askedAtMs: number
  /** Answer cues from intake. Untrusted (model output from fan text). */
  cues?: string[]
  /** Fans backing this question (asker included). Used for the verifier rule. */
  backers?: number
  /** Sum of reserved backing amounts in cents. Used for the verifier rule. */
  lockedCents?: number
  /** Optional per-backing detail; when present the guard counts only backers who joined before the answer. */
  backings?: { amountCents: number; backedAtMs: number }[]
}

export type GuardAction = 'lock' | 'review' | 'deflected' | 'ignore'

export interface GuardResult {
  action: GuardAction
  /** Quote cut by code from the transcript words (never copied from model output). */
  quote?: string
  span?: EvidenceSpan
  /** Start segment's tStartMs. Backers who joined after this are never charged. */
  answerStartMs?: number
  /** Same as answerStartMs today; kept separate for questions.quote_at_ms. */
  quoteAtMs?: number
  /** True when a lock must wait for verifyLock (>= $10 locked or >= 3 backers). */
  needsVerifier: boolean
  /** Eligible backers and cents at lock time (backers who joined before the answer). */
  backers: number
  lockedCents: number
  confidence: number
  reason: string
}

export type CallPurpose = 'intake' | 'detect' | 'verify' | 'contest'

/** Why an AI call produced no usable result. The domain switches the room to manual mode on these. */
export type AiTroubleReason =
  | 'no_client'
  | 'budget'
  | 'timeout'
  | 'rate_limit'
  | 'api_error'
  | 'connection'
  | 'refusal'
  | 'max_tokens'
  | 'bad_output'

export interface IntakeResult {
  allow: boolean
  reason?: string
  cleanText: string
  cues: string[]
  similarTo?: number
  /** 'model' when Claude ran; 'fallback' when deterministic rules were used (no key, error, budget). */
  source: 'model' | 'fallback'
}

export type ContestOutcomeState = 'refunded' | 'pending_creator' | 'upheld' | 'failed'

export interface ContestOutcome {
  state: ContestOutcomeState
  finding: ContestFinding | null
  evidence: string | null
  explanation: string
  refundId: string | null
  refundCents: number | null
  turns: number
  costMicros: number
}
