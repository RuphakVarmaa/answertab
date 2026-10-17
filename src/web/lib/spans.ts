// Transcript word selection <-> EvidenceSpan. Pure; the transcript renders each word with its (seq, index).
import type { EvidenceSpan, Segment } from '../../shared/types.js'

export interface WordRef {
  seg: number
  word: number
}

export function compareRefs(a: WordRef, b: WordRef): number {
  return a.seg - b.seg || a.word - b.word
}

/** Two clicked/dragged words in any order -> an inclusive span. */
export function spanFromRefs(a: WordRef, b: WordRef): EvidenceSpan {
  const [s, e] = compareRefs(a, b) <= 0 ? [a, b] : [b, a]
  return { startSeg: s.seg, startWord: s.word, endSeg: e.seg, endWord: e.word }
}

export function spanContains(span: EvidenceSpan, ref: WordRef): boolean {
  return (
    compareRefs({ seg: span.startSeg, word: span.startWord }, ref) <= 0 &&
    compareRefs(ref, { seg: span.endSeg, word: span.endWord }) <= 0
  )
}

/** Words covered by a span, in transcript order. Segments missing from `segments` contribute nothing. */
export function spanWords(segments: readonly Segment[], span: EvidenceSpan): string[] {
  const out: string[] = []
  const ordered = segments.filter((s) => s.final).slice().sort((a, b) => a.seq - b.seq)
  for (const seg of ordered) {
    if (seg.seq < span.startSeg || seg.seq > span.endSeg) continue
    const from = seg.seq === span.startSeg ? span.startWord : 0
    const to = seg.seq === span.endSeg ? span.endWord : seg.words.length - 1
    for (let i = Math.max(0, from); i <= Math.min(to, seg.words.length - 1); i++) out.push(seg.words[i]!)
  }
  return out
}

export function quoteFromSpan(segments: readonly Segment[], span: EvidenceSpan): string {
  return spanWords(segments, span).join(' ')
}

const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '')

/**
 * Locate a stored quote (cut by server code from these same words) back in the transcript so it can be
 * highlighted. Matches normalized tokens across segment boundaries; returns the last match, since the
 * answer usually follows earlier mentions.
 */
export function findQuoteSpan(segments: readonly Segment[], quote: string | null | undefined): EvidenceSpan | null {
  if (!quote) return null
  const target = quote.split(/\s+/).map(norm).filter(Boolean)
  if (target.length === 0) return null
  const flat: { ref: WordRef; tok: string }[] = []
  for (const seg of segments.filter((s) => s.final).slice().sort((a, b) => a.seq - b.seq)) {
    seg.words.forEach((w, i) => {
      const tok = norm(w)
      if (tok) flat.push({ ref: { seg: seg.seq, word: i }, tok })
    })
  }
  for (let i = flat.length - target.length; i >= 0; i--) {
    let ok = true
    for (let j = 0; j < target.length; j++) {
      if (flat[i + j]!.tok !== target[j]) {
        ok = false
        break
      }
    }
    if (ok) return spanFromRefs(flat[i]!.ref, flat[i + target.length - 1]!.ref)
  }
  return null
}

export type WordMove = 'prev' | 'next' | 'prevSeg' | 'nextSeg' | 'first' | 'last'

/**
 * Keyboard word picker: where the caret goes for an arrow/Home/End key. With no caret yet, any move starts
 * on the newest word (answers are usually at the end). Returns null when there are no words.
 */
export function moveWord(segments: readonly Pick<Segment, 'seq' | 'words' | 'final'>[], from: WordRef | null, move: WordMove): WordRef | null {
  const segs = segments.filter((s) => s.final && s.words.length > 0).slice().sort((a, b) => a.seq - b.seq)
  if (segs.length === 0) return null
  const first = { seg: segs[0]!.seq, word: 0 }
  const lastSeg = segs[segs.length - 1]!
  const last = { seg: lastSeg.seq, word: lastSeg.words.length - 1 }
  if (move === 'first') return first
  if (move === 'last') return last
  const si = from ? segs.findIndex((s) => s.seq === from.seg) : -1
  if (!from || si === -1) return last
  const seg = segs[si]!
  const word = Math.min(Math.max(0, from.word), seg.words.length - 1)
  switch (move) {
    case 'prev':
      if (word > 0) return { seg: seg.seq, word: word - 1 }
      return si > 0 ? { seg: segs[si - 1]!.seq, word: segs[si - 1]!.words.length - 1 } : { seg: seg.seq, word: 0 }
    case 'next':
      if (word < seg.words.length - 1) return { seg: seg.seq, word: word + 1 }
      return si < segs.length - 1 ? { seg: segs[si + 1]!.seq, word: 0 } : { seg: seg.seq, word }
    case 'prevSeg':
      return si > 0 ? { seg: segs[si - 1]!.seq, word: 0 } : { seg: seg.seq, word: 0 }
    case 'nextSeg':
      return si < segs.length - 1 ? { seg: segs[si + 1]!.seq, word: 0 } : { seg: seg.seq, word: seg.words.length - 1 }
  }
}
