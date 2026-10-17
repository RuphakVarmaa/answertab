import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { Segment } from '../src/shared/types.js'
import { compareRefs, findQuoteSpan, quoteFromSpan, spanContains, spanFromRefs, spanWords } from '../src/web/lib/spans.js'

function seg(seq: number, text: string, final = true): Segment {
  return { seq, text, words: text.trim().split(/\s+/), tStartMs: seq * 1000, tEndMs: seq * 1000 + 900, source: 'spoken', final }
}

const SEGS = [
  seg(0, 'Great question about folders, hold that thought.'),
  seg(1, 'Okay, folders: one router file per feature,'),
  seg(2, 'shared code in a core package.'),
  seg(3, 'Tests: mostly next to the code.'),
]

describe('transcript word selection -> EvidenceSpan', () => {
  it('orders the two clicked words, whichever came first', () => {
    const fwd = spanFromRefs({ seg: 1, word: 2 }, { seg: 2, word: 5 })
    const back = spanFromRefs({ seg: 2, word: 5 }, { seg: 1, word: 2 })
    expect(fwd).toEqual({ startSeg: 1, startWord: 2, endSeg: 2, endWord: 5 })
    expect(back).toEqual(fwd)
    expect(spanFromRefs({ seg: 3, word: 1 }, { seg: 3, word: 1 })).toEqual({ startSeg: 3, startWord: 1, endSeg: 3, endWord: 1 })
  })

  it('knows which words are inside a span (inclusive, across segments)', () => {
    const span = spanFromRefs({ seg: 1, word: 2 }, { seg: 2, word: 1 })
    expect(spanContains(span, { seg: 1, word: 2 })).toBe(true)
    expect(spanContains(span, { seg: 1, word: 99 })).toBe(true)
    expect(spanContains(span, { seg: 2, word: 0 })).toBe(true)
    expect(spanContains(span, { seg: 2, word: 1 })).toBe(true)
    expect(spanContains(span, { seg: 1, word: 1 })).toBe(false)
    expect(spanContains(span, { seg: 2, word: 2 })).toBe(false)
  })

  it('cuts the quote from the words in transcript order', () => {
    const span = spanFromRefs({ seg: 1, word: 2 }, { seg: 2, word: 5 })
    expect(quoteFromSpan(SEGS, span)).toBe('one router file per feature, shared code in a core package.')
    expect(spanWords(SEGS, { startSeg: 3, startWord: 0, endSeg: 3, endWord: 0 })).toEqual(['Tests:'])
  })

  it('skips interim segments and clamps out-of-range word indexes', () => {
    const segs = [...SEGS, seg(4, 'not final yet', false)]
    expect(spanWords(segs, { startSeg: 3, startWord: 5, endSeg: 4, endWord: 2 })).toEqual(['code.'])
    expect(spanWords(SEGS, { startSeg: 3, startWord: 3, endSeg: 3, endWord: 50 })).toEqual(['to', 'the', 'code.'])
  })

  it('finds a stored quote back in the transcript for highlighting, across segments and punctuation', () => {
    expect(findQuoteSpan(SEGS, 'one router file per feature, shared code')).toEqual({ startSeg: 1, startWord: 2, endSeg: 2, endWord: 1 })
    expect(findQuoteSpan(SEGS, 'ONE ROUTER FILE per feature shared code')).toEqual({ startSeg: 1, startWord: 2, endSeg: 2, endWord: 1 })
    expect(findQuoteSpan(SEGS, 'folders')).toEqual({ startSeg: 1, startWord: 1, endSeg: 1, endWord: 1 }) // last mention wins
    expect(findQuoteSpan(SEGS, 'never said this')).toBeNull()
    expect(findQuoteSpan(SEGS, '')).toBeNull()
    expect(findQuoteSpan(SEGS, null)).toBeNull()
  })

  it('round-trips any selection: the cut quote locates a span with the same words', () => {
    const word = fc.stringMatching(/^[a-z]{1,6}$/)
    const segments = fc.array(fc.array(word, { minLength: 1, maxLength: 8 }), { minLength: 1, maxLength: 6 })
    fc.assert(
      fc.property(segments, fc.nat(), fc.nat(), (wordLists, a, b) => {
        const segs = wordLists.map((ws, i) => seg(i, ws.join(' ')))
        const flat = segs.flatMap((s) => s.words.map((_, w) => ({ seg: s.seq, word: w })))
        const span = spanFromRefs(flat[a % flat.length]!, flat[b % flat.length]!)
        const quote = quoteFromSpan(segs, span)
        const found = findQuoteSpan(segs, quote)
        expect(found).not.toBeNull()
        expect(quoteFromSpan(segs, found!)).toBe(quote)
        expect(compareRefs({ seg: found!.startSeg, word: found!.startWord }, { seg: found!.endSeg, word: found!.endWord })).toBeLessThanOrEqual(0)
      }),
    )
  })
})
