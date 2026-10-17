// Shapes of eval/data/cases.jsonl rows.
import type { Segment, VerdictKind } from '../src/shared/types.js'

export type Split = 'dev' | 'val' | 'test'

export interface EvalExpected {
  questionNumber: number
  verdict: VerdictKind
  /** Every listed keyword must appear in the cut quote for a lock to count as correct evidence. */
  evidenceWords?: string[]
  /** Late-backer checks: backers who joined after the answer started must not be charged. */
  backers?: { backedAtMs: number; expectCharged: boolean }[]
}

export interface EvalCase {
  id: string
  split: Split
  category: string
  /** True for every case today: written by hand, not recorded audio run through the speech path. */
  synthetic: boolean
  /** This case is one of the detector prompt's few-shot examples (dev only). */
  fewShot?: boolean
  questions: { number: number; text: string; askedAtMs: number }[]
  window: Segment[]
  expected: EvalExpected[]
}
