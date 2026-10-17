// Renders open questions and transcript windows for the detector (and the few-shot examples, so both match).
import type { Segment } from '../../../shared/types.js'
import { wordsOf } from '../text.js'
import { clock, neutralize } from './untrusted.js'

export interface RenderQuestion {
  number: number
  text: string
  askedAtMs: number
  cues?: string[]
}

export function segmentWords(s: Pick<Segment, 'text' | 'words'>): string[] {
  return s.words && s.words.length > 0 ? s.words : wordsOf(s.text)
}

export function renderOpenQuestions(qs: RenderQuestion[]): string {
  const lines = ['<open_questions>']
  for (const q of [...qs].sort((a, b) => a.number - b.number)) {
    lines.push(`Q${q.number} | asked ${clock(q.askedAtMs)} | ${neutralize(q.text.replace(/\s+/g, ' ').trim())}`)
    const cues = (q.cues ?? []).map((c) => neutralize(c.replace(/\s+/g, ' ').trim())).filter(Boolean)
    if (cues.length > 0) lines.push(`   cues: ${cues.join('; ')}`)
  }
  lines.push('</open_questions>')
  return lines.join('\n')
}

/** One line per segment: `[seg N | mm:ss-mm:ss] [0]word [1]word ...`. Indexes restart in every segment. */
export function renderTranscript(window: Pick<Segment, 'seq' | 'text' | 'words' | 'tStartMs' | 'tEndMs'>[]): string {
  const lines = ['<transcript>']
  for (const s of [...window].sort((a, b) => a.seq - b.seq)) {
    const words = segmentWords(s).map((w, i) => `[${i}]${neutralize(w)}`)
    lines.push(`[seg ${s.seq} | ${clock(s.tStartMs)}-${clock(s.tEndMs)}] ${words.join(' ')}`)
  }
  lines.push('</transcript>')
  return lines.join('\n')
}
