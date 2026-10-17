// Contest desk: an Opus 5.5 tool loop. Read tools gather the record; one decision tool ends the run.
// The model never passes an amount or ID: deps compute the share, the refund request ID and the PayPal call.
// History is append-only (preserved thinking rejects edited history), persisted after every turn.
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessageParam,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.js'
import type { ContestFinding, Segment } from '../../shared/types.js'
import { formatCents } from '../../shared/money.js'
import { callClaude, textOf, type CreateParams } from './anthropic.js'
import { refundPolicy } from './contestPolicy.js'
import { OPUS } from './pricing.js'
import { CONTEST_SYSTEM, CONTEST_TOOLS, DECISION_TOOLS, contestOpening, contestResume } from './prompts/contestDesk.js'
import { segmentWords } from './prompts/render.js'
import { clock, neutralize } from './prompts/untrusted.js'
import type { ContestOutcome } from './types.js'

type RefundFinding = Exclude<ContestFinding, 'answered'>

export interface ContestDeskDeps {
  /** Stored contest: reason, question number, and the persisted history/progress (empty on the first run). */
  load(contestId: string): Promise<{ roomId: string | null; questionNumber: number; reason: string; messages: unknown[]; progress?: string[] }>
  getCardRecord(contestId: string): Promise<Record<string, unknown>>
  getTranscriptWindow(contestId: string, p: { around: 'answer' | 'question'; secondsBefore: number; secondsAfter: number }): Promise<Segment[]>
  /** Agent Toolkit get_order for this fan's tab (deps pick the order ID). Redacted. */
  getOrder(contestId: string): Promise<unknown>
  /** Agent Toolkit get_refund for this contest's refund, or null. */
  getRefund(contestId: string): Promise<unknown | null>
  /** refundShare(backing charge, captured, refunded) from money.ts. */
  getShare(contestId: string): Promise<{ shareCents: number }>
  /** Issues the refund (request ID refund-{contest}). Called only after the policy allows it. */
  refund(contestId: string, p: { finding: RefundFinding; evidence: string; explanation: string; amountCents: number }): Promise<{ refundId: string; status: string; amountCents: number }>
  requestCreatorApproval(contestId: string, p: { finding: RefundFinding; evidence: string; explanation: string; amountCents: number }): Promise<void>
  uphold(contestId: string, p: { evidence: string; explanation: string }): Promise<void>
  /** Stores contests.messages and contests.progress. */
  persist(contestId: string, p: { messages: BetaMessageParam[]; progress: string[] }): Promise<void>
}

export interface ContestDeskOptions {
  maxTurns?: number
  maxSpendMicros?: number
}

const DEFAULTS = { maxTurns: 6, maxSpendMicros: 400_000 }

function buildParams(messages: BetaMessageParam[]): CreateParams {
  return {
    model: OPUS,
    max_tokens: 16_000,
    betas: ['server-side-fallback-2026-07-01', 'thinking-display-updates-2026-08-18'],
    fallbacks: 'default',
    thinking: { type: 'adaptive', display: 'updates' },
    output_config: { effort: 'medium' },
    tools: CONTEST_TOOLS,
    tool_choice: { type: 'auto' },
    system: [{ type: 'text', text: CONTEST_SYSTEM, cache_control: { type: 'ephemeral' } }],
    cache_control: { type: 'ephemeral' },
    messages,
  }
}

/** After a mid-output server-side fallback, blocks before the last fallback marker are not echoed back. */
export function echoableContent(content: BetaContentBlock[]): BetaContentBlockParam[] {
  const lastFallback = content.map((b) => b.type).lastIndexOf('fallback')
  const kept =
    lastFallback < 0
      ? content
      : content.filter((b, i) => i > lastFallback || !['thinking', 'redacted_thinking', 'tool_use', 'server_tool_use'].includes(b.type))
  return kept as unknown as BetaContentBlockParam[]
}

const clip = (s: unknown, n: number): string => (typeof s === 'string' ? s.trim().slice(0, n) : '')
const clampSec = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? Math.min(300, Math.max(0, Math.round(n))) : 60)

function result(id: string, data: unknown, isError = false): BetaToolResultBlockParam {
  const text = typeof data === 'string' ? data : JSON.stringify(data)
  return { type: 'tool_result', tool_use_id: id, content: text, ...(isError ? { is_error: true } : {}) }
}

function renderSegments(segs: Segment[]): string {
  const lines = [...segs]
    .sort((a, b) => a.seq - b.seq)
    .map((s) => `[seg ${s.seq} | ${clock(s.tStartMs)}-${clock(s.tEndMs)}] ${neutralize(segmentWords(s).join(' '))}`)
  return `<transcript>\n${lines.join('\n')}\n</transcript>`
}

async function runReadTool(contestId: string, tu: BetaToolUseBlock, deps: ContestDeskDeps): Promise<BetaToolResultBlockParam> {
  const input = (tu.input ?? {}) as Record<string, unknown>
  try {
    switch (tu.name) {
      case 'get_card_record':
        return result(tu.id, `<card_record>\n${neutralize(JSON.stringify(await deps.getCardRecord(contestId)))}\n</card_record>`)
      case 'get_transcript_window': {
        const around = input.around === 'question' ? 'question' : 'answer'
        const segs = await deps.getTranscriptWindow(contestId, {
          around,
          secondsBefore: clampSec(input.seconds_before),
          secondsAfter: clampSec(input.seconds_after),
        })
        return result(tu.id, segs.length > 0 ? renderSegments(segs) : 'No transcript in that range.')
      }
      case 'get_order':
        return result(tu.id, neutralize(JSON.stringify((await deps.getOrder(contestId)) ?? null)))
      case 'get_refund':
        return result(tu.id, neutralize(JSON.stringify((await deps.getRefund(contestId)) ?? null)))
      default:
        return result(tu.id, `Unknown tool ${tu.name}.`, true)
    }
  } catch {
    return result(tu.id, `${tu.name} failed; continue with what you have.`, true)
  }
}

type Decision = { res: BetaToolResultBlockParam; outcome: Omit<ContestOutcome, 'turns' | 'costMicros'>; note: string }

async function runDecision(contestId: string, tu: BetaToolUseBlock, deps: ContestDeskDeps): Promise<Decision> {
  const input = (tu.input ?? {}) as Record<string, unknown>
  const evidence = clip(input.evidence, 800)
  const explanation = clip(input.explanation, 600)
  if (tu.name === 'uphold_charge') {
    await deps.uphold(contestId, { evidence, explanation })
    return {
      res: result(tu.id, { status: 'upheld' }),
      outcome: { state: 'upheld', finding: 'answered', evidence, explanation, refundId: null, refundCents: null },
      note: 'Charge upheld: the question was answered.',
    }
  }
  const raw = input.finding
  if (raw !== 'not_answered' && raw !== 'deferred' && raw !== 'partially_answered') throw new Error('invalid finding')
  const finding: RefundFinding = raw
  const { shareCents } = await deps.getShare(contestId)
  const policy = refundPolicy({ finding, shareCents })
  const base = { finding, evidence, explanation }
  if (policy.action === 'nothing_to_refund') {
    return {
      res: result(tu.id, { status: 'nothing_to_refund', reason: policy.reason }),
      outcome: { state: 'upheld', ...base, refundId: null, refundCents: 0 },
      note: 'Nothing left to refund on this backing.',
    }
  }
  if (policy.action === 'pending_creator') {
    await deps.requestCreatorApproval(contestId, { ...base, amountCents: policy.amountCents })
    return {
      res: result(tu.id, { status: 'pending_creator', amount: formatCents(policy.amountCents), reason: policy.reason }),
      outcome: { state: 'pending_creator', ...base, refundId: null, refundCents: policy.amountCents },
      note: `Refund of ${formatCents(policy.amountCents)} sent to the creator for approval (${policy.reason}).`,
    }
  }
  const r = await deps.refund(contestId, { ...base, amountCents: policy.amountCents })
  return {
    res: result(tu.id, { status: 'refunded', refund_id: r.refundId, refund_status: r.status, amount: formatCents(r.amountCents) }),
    outcome: { state: 'refunded', ...base, refundId: r.refundId, refundCents: r.amountCents },
    note: `Refunded ${formatCents(r.amountCents)} automatically (refund ${r.refundId}).`,
  }
}

export async function runContestDesk(
  p: { contestId: string; resume?: { approved: boolean; refundId?: string | null } },
  deps: ContestDeskDeps,
  opts: ContestDeskOptions = {},
): Promise<ContestOutcome> {
  const o = { ...DEFAULTS, ...opts }
  const c = await deps.load(p.contestId)
  const messages: BetaMessageParam[] = Array.isArray(c.messages) ? ([...c.messages] as BetaMessageParam[]) : []
  const progress: string[] = [...(c.progress ?? [])]
  const note = (s: string) => progress.push(s.replace(/\s+/g, ' ').trim().slice(0, 240))
  const save = () => deps.persist(p.contestId, { messages, progress })
  let turns = 0
  let cost = 0
  const failed = (why: string): ContestOutcome => ({
    state: 'failed',
    finding: null,
    evidence: null,
    explanation: `The contest desk could not finish (${why}); the creator will review this contest.`,
    refundId: null,
    refundCents: null,
    turns,
    costMicros: cost,
  })

  if (messages.length === 0) messages.push({ role: 'user', content: contestOpening({ questionNumber: c.questionNumber, reason: c.reason }) })
  if (p.resume) messages.push({ role: 'user', content: contestResume(p.resume) })
  note(p.resume ? 'Resuming after the creator decided.' : 'Reading the contest.')

  while (turns < o.maxTurns) {
    if (cost >= o.maxSpendMicros) {
      note('Spend cap reached.')
      await save()
      return failed('spend cap reached')
    }
    turns++
    const out = await callClaude(buildParams(messages), {
      roomId: c.roomId,
      purpose: 'contest',
      estMicros: 80_000,
      timeoutMs: 120_000,
      maxRetries: 1,
      summarize: (m) => ({ contestId: p.contestId, turn: turns, tools: m.content.filter((b) => b.type === 'tool_use').map((b) => (b as BetaToolUseBlock).name) }),
    })
    cost += out.costMicros
    if (!out.ok) {
      note(`Model call failed (${out.reason}).`)
      await save()
      return failed(out.reason)
    }
    const m = out.message
    messages.push({ role: 'assistant', content: echoableContent(m.content) })
    for (const b of m.content) if (b.type === 'thinking' && b.thinking.trim()) note(b.thinking)

    const toolUses = m.content.filter((b): b is BetaToolUseBlock => b.type === 'tool_use')
    if (toolUses.length === 0) {
      const text = textOf(m).trim().slice(0, 600)
      if (p.resume) {
        await save()
        return {
          state: p.resume.approved ? 'refunded' : 'upheld',
          finding: null,
          evidence: null,
          explanation: text || (p.resume.approved ? 'The creator approved the refund.' : 'The creator declined the refund.'),
          refundId: p.resume.refundId ?? null,
          refundCents: null,
          turns,
          costMicros: cost,
        }
      }
      messages.push({ role: 'user', content: 'Finish by calling exactly one decision tool: refund_contested_share or uphold_charge.' })
      await save()
      continue
    }

    // Every tool_use gets exactly one tool_result, all in one user message, so the history stays valid.
    const results: BetaToolResultBlockParam[] = []
    let decision: Decision | null = null
    let decisionFailed = false
    for (const tu of toolUses) {
      if (!DECISION_TOOLS.has(tu.name)) {
        results.push(await runReadTool(p.contestId, tu, deps))
        continue
      }
      if (decision || decisionFailed || p.resume) {
        results.push(result(tu.id, 'A decision has already been made; no further decision is allowed.', true))
        continue
      }
      try {
        decision = await runDecision(p.contestId, tu, deps)
        results.push(decision.res)
      } catch {
        decisionFailed = true
        results.push(result(tu.id, 'The decision could not be carried out.', true))
      }
    }
    messages.push({ role: 'user', content: results })
    if (decisionFailed) {
      note('The decision could not be carried out.')
      await save()
      return failed('decision failed')
    }
    if (decision) {
      note(decision.note)
      await save()
      return { ...decision.outcome, turns, costMicros: cost }
    }
    await save()
  }
  note('Stopped: turn limit reached without a decision.')
  await save()
  return failed('turn limit reached')
}
