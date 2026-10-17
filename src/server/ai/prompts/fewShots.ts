// Few-shot examples for the detector rubric. Each one is also a dev-split eval case (same id, same text),
// emitted by eval/build-cases.ts. They must never appear in the val or test splits (test/ai-fewshots.test.ts).
import type { EvidenceSpan, VerdictKind } from '../../../shared/types.js'

export interface FewShot {
  caseId: string
  category: string
  questions: { number: number; text: string; askedAtMs: number }[]
  segments: { seq: number; text: string; tStartMs: number; tEndMs: number }[]
  output: { questionNumber: number; verdict: VerdictKind; evidence: EvidenceSpan | null; confidence: number }[]
  why: string
}

export const FEW_SHOTS: FewShot[] = [
  {
    caseId: 'dev-fs-1',
    category: 'paraphrased',
    questions: [
      { number: 4, text: "What's the best way to learn data structures if I'm bad at math?", askedAtMs: 70_000 },
      { number: 5, text: 'Do you use Vim or VS Code?', askedAtMs: 82_000 },
    ],
    segments: [
      { seq: 31, text: 'alright let me grab some water first', tStartMs: 90_000, tEndMs: 93_000 },
      {
        seq: 32,
        text: "so for the person who's nervous about math and wants to get into data structures, honestly you need way less math than you think",
        tStartMs: 97_000,
        tEndMs: 104_000,
      },
      {
        seq: 33,
        text: 'start by drawing every structure on paper, arrays then linked lists then trees, and implement each one yourself in a language you already know',
        tStartMs: 105_000,
        tEndMs: 115_000,
      },
    ],
    output: [{ questionNumber: 4, verdict: 'answered', evidence: { startSeg: 32, startWord: 15, endSeg: 33, endWord: 23 }, confidence: 0.93 }],
    why: 'Q4 is answered in different words (concrete advice after the framing). Q5 is never addressed, so it is omitted.',
  },
  {
    caseId: 'dev-fs-2',
    category: 'deflection',
    questions: [
      { number: 2, text: 'Can you explain how Kubernetes networking works?', askedAtMs: 185_000 },
      { number: 3, text: 'Is it fine to push straight to main on my team project?', askedAtMs: 192_000 },
    ],
    segments: [
      {
        seq: 50,
        text: "oh Kubernetes networking, great question, but that's a whole stream on its own, let's park it for next week",
        tStartMs: 200_000,
        tEndMs: 207_000,
      },
      {
        seq: 51,
        text: "pushing straight to main, sure, and while you're at it delete the tests too, what could possibly go wrong",
        tStartMs: 208_000,
        tEndMs: 214_000,
      },
      { seq: 52, text: 'anyway back to the resume reviews', tStartMs: 215_000, tEndMs: 218_000 },
    ],
    output: [
      { questionNumber: 2, verdict: 'deflected', evidence: { startSeg: 50, startWord: 5, endSeg: 50, endWord: 18 }, confidence: 0.92 },
      { questionNumber: 3, verdict: 'not_yet', evidence: null, confidence: 0.85 },
    ],
    why: 'Q2 is acknowledged and postponed: deflected. Q3 gets only a sarcastic joke and no sincere reply, so it is not answered yet.',
  },
  {
    caseId: 'dev-fs-3',
    category: 'read_aloud',
    questions: [
      { number: 7, text: 'How do I stop my React component from re-rendering so much?', askedAtMs: 340_000 },
      { number: 8, text: 'Is Rust worth learning in 2026?', askedAtMs: 344_000 },
    ],
    segments: [
      { seq: 70, text: 'next one, how do I stop my React component from re-rendering so much', tStartMs: 350_000, tEndMs: 354_000 },
      {
        seq: 71,
        text: 'first check whether the parent passes a brand new object or function on every render, wrap those in useMemo or useCallback, and only then reach for React.memo on the child',
        tStartMs: 355_000,
        tEndMs: 366_000,
      },
      { seq: 72, text: "and Rust, yeah, I keep meaning to try Rust, my friend loves it", tStartMs: 367_000, tEndMs: 371_000 },
    ],
    output: [
      { questionNumber: 7, verdict: 'answered', evidence: { startSeg: 71, startWord: 0, endSeg: 71, endWord: 29 }, confidence: 0.95 },
      { questionNumber: 8, verdict: 'not_yet', evidence: null, confidence: 0.9 },
    ],
    why: 'Seg 70 only reads Q7 aloud; the evidence is the reply in seg 71. Q8 is mentioned but never answered.',
  },
  {
    caseId: 'dev-fs-4',
    category: 'answered_before_asked',
    questions: [
      { number: 10, text: 'Which database should I use for my side project?', askedAtMs: 500_000 },
      { number: 11, text: 'How long did it take you to get your first job?', askedAtMs: 510_000 },
    ],
    segments: [
      {
        seq: 88,
        text: 'it took me about eight months and something like two hundred applications to land my first developer job',
        tStartMs: 475_000,
        tEndMs: 483_000,
      },
      {
        seq: 89,
        text: "for the database question, if your data is relational just use Postgres, but it really depends on what you're building, so send me more details and I'll give you a proper answer next time",
        tStartMs: 516_000,
        tEndMs: 527_000,
      },
    ],
    output: [
      { questionNumber: 10, verdict: 'partial', evidence: { startSeg: 89, startWord: 4, endSeg: 89, endWord: 33 }, confidence: 0.8 },
      { questionNumber: 11, verdict: 'already_covered', evidence: null, confidence: 0.88 },
    ],
    why: 'Q11 was asked at 08:30, after seg 88 (07:55) had already covered it, so it is already_covered. Q10 gets a conditional pointer and the rest is postponed: partial.',
  },
]
