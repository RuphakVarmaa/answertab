import { describe, expect, it } from 'vitest'
import type { Segment, Verdict } from '../src/shared/types.js'
import { chargeForBacking } from '../src/shared/money.js'
import { cutSpan, guardCreatorSpan, guardVerdict, novelShare, snapSpanEnd } from '../src/server/ai/guard.js'
import { wordsOf } from '../src/server/ai/text.js'
import type { OpenQ } from '../src/server/ai/types.js'

const seg = (seq: number, tStartMs: number, text: string): Segment => ({
  seq,
  text,
  words: wordsOf(text),
  tStartMs,
  tEndMs: tStartMs + 4000,
  source: 'replay',
  final: true,
})

const window: Segment[] = [
  seg(5, 30_000, 'Great question about folders, hold that thought.'),
  seg(6, 44_000, 'so anyway the stream schedule changes next month'),
  seg(7, 52_000, 'Okay, folders: one router file per feature, shared code in a core package.'),
  seg(8, 60_000, "Tests: mostly next to the code, but let's do testing properly next week."),
]
const q1: OpenQ = { number: 1, text: 'How should I split a big API project into folders?', askedAtMs: 25_000 }
const q2: OpenQ = { number: 2, text: 'Should tests live next to the code?', askedAtMs: 32_000 }
const answered = (evidence: Verdict['evidence'], confidence = 0.95, n = 1): Verdict => ({ questionNumber: n, verdict: 'answered', evidence, confidence })
const opts = { tau: 0.85 }

describe('cutSpan', () => {
  it('cuts inclusive word ranges, across segments, from stored words', () => {
    const c = cutSpan({ startSeg: 7, startWord: 2, endSeg: 8, endWord: 1 }, window)
    expect(c.ok && c.quote).toBe('one router file per feature, shared code in a core package. Tests: mostly')
  })
  it.each([
    [{ startSeg: 99, startWord: 0, endSeg: 99, endWord: 3 }, 'not in window'],
    [{ startSeg: 7, startWord: 0, endSeg: 7, endWord: 13 }, 'out of range'],
    [{ startSeg: 7, startWord: 13, endSeg: 7, endWord: 13 }, 'out of range'],
    [{ startSeg: 7, startWord: 5, endSeg: 7, endWord: 2 }, 'reversed'],
    [{ startSeg: 8, startWord: 0, endSeg: 7, endWord: 2 }, 'reversed'],
    [{ startSeg: 7, startWord: -1, endSeg: 7, endWord: 2 }, 'non-negative integers'],
    [{ startSeg: 7, startWord: 1.5, endSeg: 7, endWord: 2 }, 'non-negative integers'],
  ])('rejects %j', (span, why) => {
    const c = cutSpan(span, window)
    expect(c.ok).toBe(false)
    if (!c.ok) expect(c.reason).toContain(why)
  })
})

describe('guardVerdict', () => {
  it('locks a confident answer and returns the start segment time as answerStartMs', () => {
    const g = guardVerdict(answered({ startSeg: 7, startWord: 0, endSeg: 7, endWord: 12 }), q1, window, opts)
    expect(g.action).toBe('lock')
    expect(g.quote).toBe('Okay, folders: one router file per feature, shared code in a core package.')
    expect(g.answerStartMs).toBe(52_000)
    expect(g.quoteAtMs).toBe(52_000)
    expect(g.needsVerifier).toBe(false)
  })

  it('ignores out-of-range spans and spans shorter than 4 words', () => {
    expect(guardVerdict(answered({ startSeg: 7, startWord: 0, endSeg: 7, endWord: 40 }), q1, window, opts).action).toBe('ignore')
    const short = guardVerdict(answered({ startSeg: 7, startWord: 2, endSeg: 7, endWord: 4 }), q1, window, opts)
    expect(short.action).toBe('ignore')
    expect(short.reason).toContain('needs 4')
    expect(guardVerdict(answered(null), q1, window, opts).action).toBe('ignore')
  })

  it('rejects a span that only restates the question (creator reads it aloud)', () => {
    const w = [...window, seg(9, 70_000, 'Sam asks how should I split a big API project into folders')]
    const g = guardVerdict(answered({ startSeg: 9, startWord: 0, endSeg: 9, endWord: 10 }), q1, w, opts)
    expect(g.action).toBe('ignore')
    expect(g.reason).toContain('restates')
  })

  it('does not treat a short yes/no reply as a restatement', () => {
    const q: OpenQ = { number: 3, text: 'Do you use Prettier?', askedAtMs: 34_000 }
    const w = [seg(10, 41_000, 'and yes I use prettier on everything')]
    expect(novelShare(['yes', 'I', 'use', 'prettier'], q.text)).toBeGreaterThan(0.2)
    expect(guardVerdict(answered({ startSeg: 10, startWord: 1, endSeg: 10, endWord: 4 }, 0.92, 3), q, w, opts).action).toBe('lock')
  })

  it('rejects spans that start before the question was asked, with 2 s tolerance at the boundary', () => {
    const q = { ...q1, askedAtMs: 54_000 } // answer segment starts at 52_000
    expect(guardVerdict(answered({ startSeg: 7, startWord: 0, endSeg: 7, endWord: 12 }), q, window, opts).action).toBe('lock')
    const late = { ...q1, askedAtMs: 54_001 }
    const g = guardVerdict(answered({ startSeg: 7, startWord: 0, endSeg: 7, endWord: 12 }), late, window, opts)
    expect(g.action).toBe('ignore')
    expect(g.reason).toContain('before the question')
  })

  it('applies thresholds: >= tau locks, [0.6, tau) reviews, < 0.6 ignores, partial reviews', () => {
    const span = { startSeg: 7, startWord: 0, endSeg: 7, endWord: 12 }
    expect(guardVerdict(answered(span, 0.85), q1, window, opts).action).toBe('lock')
    expect(guardVerdict(answered(span, 0.84), q1, window, opts).action).toBe('review')
    expect(guardVerdict(answered(span, 0.6), q1, window, opts).action).toBe('review')
    expect(guardVerdict(answered(span, 0.59), q1, window, opts).action).toBe('ignore')
    const partial: Verdict = { questionNumber: 2, verdict: 'partial', evidence: { startSeg: 8, startWord: 0, endSeg: 8, endWord: 12 }, confidence: 0.99 }
    expect(guardVerdict(partial, q2, window, opts).action).toBe('review')
  })

  it('deflected keeps the card open; already_covered, not_yet and wrong numbers are ignored', () => {
    const d = guardVerdict({ questionNumber: 1, verdict: 'deflected', evidence: { startSeg: 5, startWord: 0, endSeg: 5, endWord: 6 }, confidence: 0.9 }, q1, window, opts)
    expect(d.action).toBe('deflected')
    expect(d.quote).toBe('Great question about folders, hold that thought.')
    expect(guardVerdict({ questionNumber: 1, verdict: 'already_covered', evidence: null, confidence: 0.9 }, q1, window, opts).action).toBe('ignore')
    expect(guardVerdict({ questionNumber: 1, verdict: 'not_yet', evidence: null, confidence: 0.9 }, q1, window, opts).action).toBe('ignore')
    expect(guardVerdict(answered({ startSeg: 7, startWord: 0, endSeg: 7, endWord: 12 }, 0.99, 2), q1, window, opts).action).toBe('ignore')
  })

  it('snaps a span that stops 1-2 words before its segment end, after the checks ran', () => {
    expect(snapSpanEnd({ startSeg: 7, startWord: 0, endSeg: 7, endWord: 10 }, window)).toEqual({ startSeg: 7, startWord: 0, endSeg: 7, endWord: 12 })
    expect(snapSpanEnd({ startSeg: 7, startWord: 0, endSeg: 7, endWord: 9 }, window).endWord).toBe(9)
    const g = guardVerdict(answered({ startSeg: 7, startWord: 1, endSeg: 7, endWord: 11 }), q1, window, opts)
    expect(g.quote).toBe('folders: one router file per feature, shared code in a core package.')
  })

  it('sends very long spans to review instead of locking', () => {
    const long = seg(9, 70_000, Array.from({ length: 130 }, (_, i) => `word${i}`).join(' '))
    const g = guardVerdict(answered({ startSeg: 9, startWord: 0, endSeg: 9, endWord: 129 }), q1, [...window, long], opts)
    expect(g.action).toBe('review')
  })

  it('requires the verifier at >= $10 locked or >= 3 backers', () => {
    const span = { startSeg: 7, startWord: 0, endSeg: 7, endWord: 12 }
    expect(guardVerdict(answered(span), { ...q1, lockedCents: 999, backers: 2 }, window, opts).needsVerifier).toBe(false)
    expect(guardVerdict(answered(span), { ...q1, lockedCents: 1000, backers: 1 }, window, opts).needsVerifier).toBe(true)
    expect(guardVerdict(answered(span), { ...q1, lockedCents: 900, backers: 3 }, window, opts).needsVerifier).toBe(true)
  })

  it('counts only backers who joined before the answer, and money.ts charges late backers nothing', () => {
    const q: OpenQ = {
      ...q1,
      backings: [
        { amountCents: 600, backedAtMs: 26_000 },
        { amountCents: 300, backedAtMs: 40_000 },
        { amountCents: 300, backedAtMs: 52_000 },
        { amountCents: 300, backedAtMs: 53_000 },
      ],
    }
    const g = guardVerdict(answered({ startSeg: 7, startWord: 0, endSeg: 7, endWord: 12 }), q, window, opts)
    expect(g.answerStartMs).toBe(52_000)
    expect(g.backers).toBe(3)
    expect(g.lockedCents).toBe(1200)
    expect(g.needsVerifier).toBe(true)
    const charges = q.backings!.map((b) => chargeForBacking({ amountCents: b.amountCents, rating: 'full', backedAtMs: b.backedAtMs, answerStartMs: g.answerStartMs! }))
    expect(charges).toEqual([600, 300, 300, 0])
  })

  it('creator-pointed spans pass the same checks and skip the verifier', () => {
    const ok = guardCreatorSpan({ startSeg: 7, startWord: 0, endSeg: 7, endWord: 12 }, { ...q1, lockedCents: 5000, backers: 9 }, window)
    expect(ok.action).toBe('lock')
    expect(ok.needsVerifier).toBe(false)
    expect(guardCreatorSpan({ startSeg: 5, startWord: 0, endSeg: 5, endWord: 1 }, q1, window).action).toBe('ignore')
  })
})
