// Lock verifier prompt (Opus 5.5, effort low). Thinking stays on (it cannot be disabled on Opus 5.5).
import type { EvidenceSpan, Segment } from '../../../shared/types.js'
import type { CreateParams } from '../anthropic.js'
import { OPUS } from '../pricing.js'
import { segmentWords } from './render.js'
import { clock, neutralize, UNTRUSTED_NOTICE } from './untrusted.js'

export const VERIFIER_SYSTEM = `You independently audit a proposed charge on AnswerTab. A fan paid to ask a live-stream creator a question and is charged only if the creator answered it on stream. A fast detector proposed that the quote below answers the question. You re-read the question, the quote and the surrounding transcript yourself and decide whether you agree.

${UNTRUSTED_NOTICE}

Agree only when the quote, read in context, is the creator's sincere, substantive reply to what this question asks: a recommendation, explanation, yes/no with a reason, or concrete steps. Disagree when the quote is the question being read aloud, a deflection or postponement, sarcasm, a mere mention of the topic, an answer to a different question, an answer given before the question was asked, or too garbled to tell. A brief but direct answer is enough; it does not need to be complete or correct.

Reply with agree (true/false) and a one-sentence reason a creator could read.`

export const VERIFIER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['agree', 'reason'],
  properties: { agree: { type: 'boolean' }, reason: { type: 'string' } },
} as const

export function buildVerifierRequest(p: {
  question: { number: number; text: string; askedAtMs?: number }
  quote: string
  window: Segment[]
  span?: EvidenceSpan
}): CreateParams {
  const asked = p.question.askedAtMs !== undefined ? ` (asked at ${clock(p.question.askedAtMs)})` : ''
  const lines = [...p.window]
    .sort((a, b) => a.seq - b.seq)
    .map((s) => `[seg ${s.seq} | ${clock(s.tStartMs)}-${clock(s.tEndMs)}] ${neutralize(segmentWords(s).join(' '))}`)
  const where = p.span ? `\nThe quote is seg ${p.span.startSeg} word ${p.span.startWord} through seg ${p.span.endSeg} word ${p.span.endWord}.` : ''
  return {
    model: OPUS,
    max_tokens: 4000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low', format: { type: 'json_schema', schema: VERIFIER_SCHEMA as unknown as Record<string, unknown> } },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: [{ type: 'text', text: VERIFIER_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: `<question>\nQ${p.question.number}${asked}: ${neutralize(p.question.text)}\n</question>\n<quote>\n${neutralize(p.quote)}\n</quote>${where}\n<transcript>\n${lines.join('\n')}\n</transcript>\nDo you agree that the quote answers the question?`,
      },
    ],
  }
}
