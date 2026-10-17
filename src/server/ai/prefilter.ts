// Cheap, deterministic check that decides whether a new final segment is worth a detector call.
// Looks at the last ~60 s of transcript for generic answer/deflection phrases, intake cues, a question
// number, or at least two content words shared with an open question.
import type { Segment } from '../../shared/types.js'
import { contentTokens, normPhrase } from './text.js'
import type { OpenQ } from './types.js'

export const GENERIC_PHRASES = [
  'someone asked',
  'somebody asked',
  'you asked',
  'asked about',
  'great question',
  'good question',
  'about your question',
  'your question',
  'the question',
  'question about',
  'question from',
  'next question',
  'to answer',
  'the answer',
  'short answer',
  'my answer',
  'as for',
  'regarding',
  'hold that thought',
  'come back to',
  'get back to',
  'next week',
  'next stream',
  'later in the stream',
  'park that',
  'park it',
]

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve']

export interface PrefilterResult {
  hit: boolean
  reason: string
}

function hasPhrase(hay: string, phrase: string): boolean {
  const p = normPhrase(phrase)
  return p !== '' && ` ${hay} `.includes(` ${p} `)
}

export function prefilterHit(p: { segments: Segment[]; openQuestions: OpenQ[]; lookbackMs?: number }): PrefilterResult {
  if (p.openQuestions.length === 0) return { hit: false, reason: 'no open questions' }
  const finals = p.segments.filter((s) => s.final)
  if (finals.length === 0) return { hit: false, reason: 'no transcript' }
  const newest = Math.max(...finals.map((s) => s.tEndMs))
  const recent = finals.filter((s) => s.tEndMs >= newest - (p.lookbackMs ?? 60_000))
  const hay = normPhrase(recent.map((s) => s.text).join(' '))

  for (const phrase of GENERIC_PHRASES) if (hasPhrase(hay, phrase)) return { hit: true, reason: `phrase: ${phrase}` }

  const recentTokens = new Set(contentTokens(recent.map((s) => s.text).join(' ')))
  for (const q of p.openQuestions) {
    const n = q.number
    const numberForms = [`q${n}`, `#${n}`, `question ${n}`, `number ${n}`]
    if (n < NUMBER_WORDS.length) numberForms.push(`question ${NUMBER_WORDS[n]}`, `number ${NUMBER_WORDS[n]}`)
    for (const f of numberForms) if (hasPhrase(hay, f)) return { hit: true, reason: `question number ${n}` }

    for (const cue of q.cues ?? []) if (cue.trim().length >= 3 && hasPhrase(hay, cue)) return { hit: true, reason: `cue for Q${n}` }

    const qTokens = new Set(contentTokens(q.text, { dropMeta: true }))
    let shared = 0
    for (const t of qTokens) if (recentTokens.has(t)) shared++
    if (shared >= Math.min(2, qTokens.size) && shared > 0) return { hit: true, reason: `overlap with Q${n}` }
  }
  return { hit: false, reason: 'no cue' }
}
