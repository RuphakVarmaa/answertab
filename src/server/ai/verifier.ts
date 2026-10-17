// Opus 5.5 re-check of big locks (>= $10 or >= 3 backers). Any failure counts as disagreement -> review.
import type { EvidenceSpan, Segment } from '../../shared/types.js'
import { callClaude, textOf } from './anthropic.js'
import { buildVerifierRequest } from './prompts/verifier.js'

export async function verifyLock(p: {
  roomId: string | null
  question: { number: number; text: string; askedAtMs?: number }
  quote: string
  window: Segment[]
  span?: EvidenceSpan
}): Promise<{ agree: boolean; reason: string }> {
  try {
    const out = await callClaude(buildVerifierRequest(p), {
      roomId: p.roomId,
      purpose: 'verify',
      estMicros: 40_000,
      timeoutMs: 45_000,
      maxRetries: 1,
      summarize: (m) => {
        try {
          const d = JSON.parse(textOf(m)) as { agree?: unknown }
          return { agree: d.agree, model: m.model }
        } catch {
          return { unparsed: true }
        }
      },
    })
    if (!out.ok) return { agree: false, reason: `verifier unavailable (${out.reason}); sent to review` }
    const d = JSON.parse(textOf(out.message)) as { agree?: unknown; reason?: unknown }
    if (typeof d.agree !== 'boolean') return { agree: false, reason: 'verifier output unreadable; sent to review' }
    const reason = typeof d.reason === 'string' && d.reason.trim() ? d.reason.trim().slice(0, 300) : d.agree ? 'agrees' : 'disagrees'
    return { agree: d.agree, reason }
  } catch {
    return { agree: false, reason: 'verifier error; sent to review' }
  }
}
