// The judge-mode replay: the brief's video script (demo_video_script_outline, 0:20-1:15) as data.
// Offsets are milliseconds on the room clock (since the room went live). The director runs the steps in order;
// when it falls behind (slow sandbox, a slow model call) the rest of the timeline shifts later as one block, so
// the spacing between steps and the scripted segment times stay consistent with when things really happened.
import type { QuestionState } from '../../shared/types.js'

/** The three strip bots, in DemoContext.stripFans order. */
export type BotRole = 'asha' | 'ben' | 'chen'
export const BOT_ORDER: readonly BotRole[] = ['asha', 'ben', 'chen']

/** Cards the script refers to. */
export type CardRef = 'q1' | 'q2'

export const SCRIPT_TEXT = {
  q1: 'How should I split a big API project into folders?',
  /** Ben's near-duplicate of Q1 (content-word overlap 0.71, so the no-key fallback flags it too). */
  q1Duplicate: "What's the best way to split a big API project into folders?",
  q2: 'Should tests live next to the code?',
  deflection: 'Great question about folders, hold that thought.',
  answer: 'Okay, folders: one router file per feature, shared code in a core package.',
  partial: "Tests: mostly next to the code, but let's do testing properly next week.",
} as const

/** The quote the Q1 lock must carry (tests and the synthetic run check for it). */
export const Q1_QUOTE_FRAGMENT = 'one router file per feature'

export type ScriptStep =
  | { kind: 'ask'; id: string; atMs: number; by: BotRole; text: string; ref: CardRef }
  /** Near-duplicate with checkSimilar: the intake hint answers 409 and nothing is reserved. */
  | { kind: 'askSimilar'; id: string; atMs: number; by: BotRole; text: string; similarTo: CardRef }
  | { kind: 'back'; id: string; atMs: number; by: BotRole; ref: CardRef }
  | {
      kind: 'say'
      id: string
      /** Scripted segment offsets; the final segment is posted at tEndMs (when the sentence ends). */
      tStartMs: number
      tEndMs: number
      text: string
      /** Interim "possible answer" text at these fractions of the sentence (never locks). */
      interims: number[]
      /** Wait until this card is in one of these states (or the safety timeout). */
      expect: { ref: CardRef; states: QuestionState[]; timeoutMs: number }
    }

export const DEMO_SCRIPT: readonly ScriptStep[] = [
  { kind: 'ask', id: 'asha-asks-q1', atMs: 2_500, by: 'asha', text: SCRIPT_TEXT.q1, ref: 'q1' },
  { kind: 'askSimilar', id: 'ben-near-duplicate', atMs: 5_000, by: 'ben', text: SCRIPT_TEXT.q1Duplicate, similarTo: 'q1' },
  { kind: 'back', id: 'ben-backs-q1', atMs: 6_500, by: 'ben', ref: 'q1' },
  { kind: 'back', id: 'chen-backs-q1', atMs: 8_000, by: 'chen', ref: 'q1' },
  { kind: 'ask', id: 'chen-asks-q2', atMs: 9_500, by: 'chen', text: SCRIPT_TEXT.q2, ref: 'q2' },
  {
    kind: 'say',
    id: 'deflection',
    tStartMs: 13_000,
    tEndMs: 15_500,
    text: SCRIPT_TEXT.deflection,
    interims: [0.5],
    // Anything but open means the detector has spoken; 'deflected' is the scripted outcome.
    expect: { ref: 'q1', states: ['deflected', 'verifying', 'locked', 'review'], timeoutMs: 8_000 },
  },
  {
    kind: 'say',
    id: 'answer-q1',
    // 4.5 s after the deflection ends ("about 4-6 s later").
    tStartMs: 20_000,
    tEndMs: 24_000,
    text: SCRIPT_TEXT.answer,
    interims: [0.4, 0.75],
    // $12 from 3 backers: the Opus verifier runs before the lock; wait for its result.
    expect: { ref: 'q1', states: ['locked', 'review'], timeoutMs: 9_000 },
  },
  {
    kind: 'say',
    id: 'partial-q2',
    tStartMs: 27_000,
    tEndMs: 31_500,
    text: SCRIPT_TEXT.partial,
    interims: [0.45, 0.8],
    expect: { ref: 'q2', states: ['review', 'locked'], timeoutMs: 8_000 },
  },
]

/** The autoplay must start within 10 s of POST /api/demo and finish within 45 s. */
export const AUTOPLAY_START_MAX_MS = 10_000
export const AUTOPLAY_BUDGET_MS = 45_000
/** How long the director waits for the bot holds before it starts with whoever is held. */
export const TABS_READY_TIMEOUT_MS = 8_000
