// Deterministic guard between the model's verdict and any money state. Pure: no I/O, no clock.
// The quote is cut from the stored transcript words via the span; the model's text is never used.
import type { EvidenceSpan, Segment, Verdict } from '../../shared/types.js'
import { config } from '../config.js'
import { segmentWords } from './prompts/render.js'
import { contentTokens, normToken } from './text.js'
import type { GuardResult, OpenQ } from './types.js'

export interface GuardOptions {
  /** Lock threshold. Default: config().detectTau (env DETECT_TAU, 0.85). */
  tau?: number
  /** Floor of the review band. */
  reviewMin?: number
  minWords?: number
  /** Longer spans are not precise evidence; they go to review instead of locking. */
  maxWords?: number
  /** Clock-stamping slack: the answer may start this much before asked_at_ms. */
  timingToleranceMs?: number
  /** Locks at or above this many cents, or with this many backers, wait for the verifier. */
  verifyCents?: number
  verifyBackers?: number
  /** A quote whose content words are at most this share new (not in the question) restates the question. */
  restateMaxNovelShare?: number
  /** A span that stops this many words or fewer before its segment's end is extended to the end (quote only). */
  snapEndWords?: number
}

export const GUARD_DEFAULTS = {
  reviewMin: 0.6,
  minWords: 4,
  maxWords: 120,
  timingToleranceMs: 2000,
  verifyCents: 1000,
  verifyBackers: 3,
  restateMaxNovelShare: 0.2,
  snapEndWords: 2,
} as const

function defaultTau(): number {
  try {
    const t = config().detectTau
    return Number.isFinite(t) && t > 0 && t <= 1 ? t : 0.85
  } catch {
    return 0.85
  }
}

export type SpanCut =
  | { ok: true; words: string[]; quote: string; startSegment: Segment; endSegment: Segment }
  | { ok: false; reason: string }

/** Cuts the inclusive span from the window. Fails on any out-of-range or reversed index. */
export function cutSpan(span: EvidenceSpan, window: Segment[]): SpanCut {
  const { startSeg, startWord, endSeg, endWord } = span
  if (![startSeg, startWord, endSeg, endWord].every((n) => Number.isSafeInteger(n) && n >= 0)) {
    return { ok: false, reason: 'span indexes must be non-negative integers' }
  }
  if (endSeg < startSeg || (endSeg === startSeg && endWord < startWord)) return { ok: false, reason: 'span is reversed' }
  const segs = [...window].sort((a, b) => a.seq - b.seq)
  const start = segs.find((s) => s.seq === startSeg)
  const end = segs.find((s) => s.seq === endSeg)
  if (!start || !end) return { ok: false, reason: 'span segment not in window' }
  const startWords = segmentWords(start)
  const endWords = segmentWords(end)
  if (startWord >= startWords.length || endWord >= endWords.length) return { ok: false, reason: 'span word index out of range' }
  const words: string[] = []
  for (const s of segs) {
    if (s.seq < startSeg || s.seq > endSeg) continue
    const w = segmentWords(s)
    const from = s.seq === startSeg ? startWord : 0
    const to = s.seq === endSeg ? endWord : w.length - 1
    words.push(...w.slice(from, to + 1))
  }
  return { ok: true, words, quote: words.join(' '), startSegment: start, endSegment: end }
}

// Stopwords elsewhere, but a bare "yes"/"no" is the answer to a yes/no question, never part of reading it aloud.
const ANSWER_WORDS = new Set(['yes', 'no', 'yeah', 'yep', 'nope', 'nah'])

/** Share of the quote's content words that are new relative to the question (meta words like "asked" ignored). */
export function novelShare(quoteWords: string[], questionText: string): number {
  const qWords = new Set(questionText.split(/\s+/).map(normToken))
  const q = new Set(contentTokens(questionText, { dropMeta: true }))
  const answerWords = quoteWords.map(normToken).filter((w) => ANSWER_WORDS.has(w) && !qWords.has(w))
  const quote = [...contentTokens(quoteWords, { dropMeta: true }), ...answerWords]
  if (quote.length === 0) return 0
  return quote.filter((t) => !q.has(t)).length / quote.length
}

/** Models often stop a span one or two words short of the sentence end; extend those to the segment end. */
export function snapSpanEnd(span: EvidenceSpan, window: Segment[], maxGap: number = GUARD_DEFAULTS.snapEndWords): EvidenceSpan {
  const end = window.find((s) => s.seq === span.endSeg)
  if (!end) return span
  const last = segmentWords(end).length - 1
  const gap = last - span.endWord
  return gap >= 1 && gap <= maxGap ? { ...span, endWord: last } : span
}

export type SpanCheck =
  | { ok: true; quote: string; words: string[]; answerStartMs: number }
  | { ok: false; reason: string; review?: boolean }

/** The span checks shared by model verdicts and creator-pointed spans. */
export function checkSpan(span: EvidenceSpan, q: Pick<OpenQ, 'text' | 'askedAtMs'>, window: Segment[], opts: GuardOptions = {}): SpanCheck {
  const o = { ...GUARD_DEFAULTS, ...opts }
  const cut = cutSpan(span, window)
  if (!cut.ok) return cut
  if (cut.words.length < o.minWords) return { ok: false, reason: `span has ${cut.words.length} words, needs ${o.minWords}` }
  const answerStartMs = cut.startSegment.tStartMs
  if (answerStartMs < q.askedAtMs - o.timingToleranceMs) return { ok: false, reason: 'span starts before the question was asked' }
  if (novelShare(cut.words, q.text) <= o.restateMaxNovelShare) return { ok: false, reason: 'span restates the question' }
  if (cut.words.length > o.maxWords) return { ok: false, reason: `span has ${cut.words.length} words, over ${o.maxWords}`, review: true }
  return { ok: true, quote: cut.quote, words: cut.words, answerStartMs }
}

function eligible(q: OpenQ, answerStartMs: number | undefined): { backers: number; lockedCents: number } {
  if (q.backings && answerStartMs !== undefined) {
    const ok = q.backings.filter((b) => b.backedAtMs <= answerStartMs)
    return { backers: ok.length, lockedCents: ok.reduce((a, b) => a + b.amountCents, 0) }
  }
  return { backers: q.backers ?? 0, lockedCents: q.lockedCents ?? 0 }
}

/**
 * answered + confidence >= TAU -> lock; answered in [reviewMin, TAU) or partial >= reviewMin -> review;
 * deflected -> deflected (card stays open, nobody charged); everything else, or a failed span check -> ignore.
 */
export function guardVerdict(v: Verdict, q: OpenQ, window: Segment[], opts: GuardOptions = {}): GuardResult {
  const tau = opts.tau ?? defaultTau()
  const reviewMin = opts.reviewMin ?? GUARD_DEFAULTS.reviewMin
  const confidence = Number.isFinite(v.confidence) ? Math.min(1, Math.max(0, v.confidence)) : 0
  const base = { needsVerifier: false, backers: 0, lockedCents: 0, confidence }
  const ignore = (reason: string): GuardResult => ({ action: 'ignore', reason, ...base })

  if (v.questionNumber !== q.number) return ignore('verdict is for another question')
  if (v.verdict === 'already_covered' || v.verdict === 'not_yet') return ignore(v.verdict)

  if (v.verdict === 'deflected') {
    const span = v.evidence ? snapSpanEnd(v.evidence, window, opts.snapEndWords) : null
    const quoted = span ? cutSpan(span, window) : null
    const okQuote = quoted && quoted.ok && quoted.startSegment.tStartMs >= q.askedAtMs - (opts.timingToleranceMs ?? GUARD_DEFAULTS.timingToleranceMs)
    if (v.evidence && !okQuote) return ignore('deflection span invalid or before the question')
    return {
      action: 'deflected',
      reason: 'deflected; not charged',
      ...base,
      ...(okQuote && quoted.ok && span ? { quote: quoted.quote, span, quoteAtMs: quoted.startSegment.tStartMs } : {}),
    }
  }

  // answered | partial
  if (!v.evidence) return ignore('no evidence span')
  if (confidence < reviewMin) return ignore(`confidence ${confidence.toFixed(2)} below ${reviewMin}`)
  const check = checkSpan(v.evidence, q, window, opts)
  if (!check.ok && !check.review) return ignore(check.reason)

  // Checks ran on the model's exact span; the stored quote/span may extend to the segment end (snapSpanEnd).
  const span = snapSpanEnd(v.evidence, window, opts.snapEndWords)
  const cut = cutSpan(span, window)
  const quote = cut.ok ? cut.quote : undefined
  const answerStartMs = check.ok ? check.answerStartMs : cut.ok ? cut.startSegment.tStartMs : undefined
  const el = eligible(q, answerStartMs)
  const evidence = { quote, span, answerStartMs, quoteAtMs: answerStartMs, backers: el.backers, lockedCents: el.lockedCents }

  if (!check.ok) return { action: 'review', reason: check.reason, ...base, ...evidence }
  if (v.verdict === 'partial') return { action: 'review', reason: 'partial answer', ...base, ...evidence }
  if (confidence < tau) return { action: 'review', reason: `confidence ${confidence.toFixed(2)} below lock threshold ${tau}`, ...base, ...evidence }

  const verifyCents = opts.verifyCents ?? GUARD_DEFAULTS.verifyCents
  const verifyBackers = opts.verifyBackers ?? GUARD_DEFAULTS.verifyBackers
  const needsVerifier = el.lockedCents >= verifyCents || el.backers >= verifyBackers
  return { action: 'lock', reason: needsVerifier ? 'answered; verifier required' : 'answered', ...base, ...evidence, needsVerifier }
}

/** A creator-pointed span passes the same span checks; it locks without a confidence threshold. */
export function guardCreatorSpan(span: EvidenceSpan, q: OpenQ, window: Segment[], opts: GuardOptions = {}): GuardResult {
  const r = guardVerdict({ questionNumber: q.number, verdict: 'answered', evidence: span, confidence: 1 }, q, window, { ...opts, tau: 0 })
  // The creator already confirmed it, so the Opus re-check does not apply.
  return r.action === 'lock' ? { ...r, needsVerifier: false, reason: 'creator-pointed span' } : r
}
