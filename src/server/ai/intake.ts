// Question intake. Model path: allow/reject, clean text, cues, similar_to. Fallback path (no key, budget,
// API error): deterministic rules, always allow non-empty questions (the creator can hide them).
import { callClaude, textOf } from './anthropic.js'
import { buildIntakeRequest } from './prompts/intake.js'
import { contentTokens, jaccard, wordsOf } from './text.js'
import type { IntakeResult } from './types.js'

export const MAX_QUESTION_CHARS = 500

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** Up to 6 distinct content words, in order of first appearance. */
export function fallbackCues(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const w of wordsOf(text)) {
    const t = contentTokens([w], { dropMeta: true })[0]
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(w.toLowerCase().replace(/[^\p{L}\p{N}+#.-]/gu, ''))
    if (out.length === 6) break
  }
  return out.filter(Boolean)
}

/** Minimum content-word Jaccard for accepting the model's similar_to (synonym-only duplicates are missed, by design). */
export const MODEL_SIMILAR_MIN_OVERLAP = 0.15

export function similarityOverlap(a: string, b: string): number {
  return jaccard(contentTokens(a, { dropMeta: true }), contentTokens(b, { dropMeta: true }))
}

/** Near-duplicate by content-word Jaccard (>= 0.5). */
export function fallbackSimilar(text: string, open: { number: number; text: string }[]): number | undefined {
  const mine = contentTokens(text, { dropMeta: true })
  let best: { n: number; score: number } | null = null
  for (const q of open) {
    const score = jaccard(mine, contentTokens(q.text, { dropMeta: true }))
    if (score >= 0.5 && (!best || score > best.score)) best = { n: q.number, score }
  }
  return best?.n
}

function fallback(text: string, open: { number: number; text: string }[]): IntakeResult {
  const cleanText = collapse(text)
  const similarTo = fallbackSimilar(cleanText, open)
  return { allow: true, cleanText, cues: fallbackCues(cleanText), source: 'fallback', ...(similarTo !== undefined ? { similarTo } : {}) }
}

function sanitizeCues(raw: unknown, text: string): string[] {
  const list = Array.isArray(raw) ? raw : []
  const cues = [
    ...new Set(
      list
        .filter((c): c is string => typeof c === 'string')
        .map((c) => collapse(c).toLowerCase().slice(0, 40))
        .filter((c) => c.length >= 2),
    ),
  ].slice(0, 6)
  if (cues.length >= 3) return cues
  for (const c of fallbackCues(text)) {
    if (cues.length >= 3) break
    if (!cues.includes(c)) cues.push(c)
  }
  return cues
}

export async function intakeQuestion(p: {
  roomId: string | null
  text: string
  openQuestions: { number: number; text: string }[]
  roomTitle?: string
}): Promise<IntakeResult> {
  const text = collapse(p.text)
  if (text.length < 3) return { allow: false, reason: 'empty', cleanText: text, cues: [], source: 'fallback' }
  if (text.length > MAX_QUESTION_CHARS) return { allow: false, reason: 'too_long', cleanText: text.slice(0, MAX_QUESTION_CHARS), cues: [], source: 'fallback' }

  try {
    const out = await callClaude(buildIntakeRequest({ text, openQuestions: p.openQuestions, roomTitle: p.roomTitle }), {
      roomId: p.roomId,
      purpose: 'intake',
      estMicros: 1_000,
      timeoutMs: 8_000,
      maxRetries: 1,
      summarize: (m) => {
        try {
          const d = JSON.parse(textOf(m)) as Record<string, unknown>
          return { allow: d.allow, reject_reason: d.reject_reason, similar_to: d.similar_to, cues: d.cues }
        } catch {
          return { unparsed: true }
        }
      },
    })
    if (!out.ok) return fallback(text, p.openQuestions)
    const d = JSON.parse(textOf(out.message)) as Record<string, unknown>
    if (typeof d.allow !== 'boolean') return fallback(text, p.openQuestions)
    const target = typeof d.similar_to === 'number' ? p.openQuestions.find((q) => q.number === d.similar_to) : undefined
    // Code checks the model: a "similar" verdict also needs some shared content words, so two questions on
    // the same theme (folder layout vs. where tests live) are not offered as duplicates.
    const similar = target && similarityOverlap(text, target.text) >= MODEL_SIMILAR_MIN_OVERLAP ? target.number : undefined
    const clean = typeof d.clean_text === 'string' ? collapse(d.clean_text).slice(0, MAX_QUESTION_CHARS) : ''
    const reason = typeof d.reject_reason === 'string' && d.reject_reason !== 'none' ? d.reject_reason : 'rejected'
    return {
      allow: d.allow,
      ...(d.allow ? {} : { reason }),
      cleanText: clean.length >= 3 ? clean : text,
      cues: d.allow ? sanitizeCues(d.cues, text) : [],
      source: 'model',
      ...(d.allow && similar !== undefined ? { similarTo: similar } : {}),
    }
  } catch {
    return fallback(text, p.openQuestions)
  }
}
