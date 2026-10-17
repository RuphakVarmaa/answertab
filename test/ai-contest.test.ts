import { afterEach, describe, expect, it } from 'vitest'
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.js'
import { setAnthropicClientForTests } from '../src/server/ai/anthropic.js'
import { runContestDesk, echoableContent, type ContestDeskDeps } from '../src/server/ai/contestDesk.js'
import { refundPolicy } from '../src/server/ai/contestPolicy.js'
import { scriptedClient, type FakeStep } from '../src/server/ai/fakeClient.js'
import { wordsOf } from '../src/server/ai/text.js'

afterEach(() => setAnthropicClientForTests(undefined))

describe('refundPolicy', () => {
  it('auto-refunds only not_answered/deferred shares up to $5', () => {
    expect(refundPolicy({ finding: 'not_answered', shareCents: 300 }).action).toBe('auto_refund')
    expect(refundPolicy({ finding: 'deferred', shareCents: 500 }).action).toBe('auto_refund')
    expect(refundPolicy({ finding: 'deferred', shareCents: 501 }).action).toBe('pending_creator')
    expect(refundPolicy({ finding: 'partially_answered', shareCents: 100 }).action).toBe('pending_creator')
    expect(refundPolicy({ finding: 'answered', shareCents: 100 }).action).toBe('pending_creator')
    expect(refundPolicy({ finding: 'not_answered', shareCents: 0 }).action).toBe('nothing_to_refund')
    expect(() => refundPolicy({ finding: 'not_answered', shareCents: 1.5 })).toThrow()
  })
})

const toolUse = (id: string, name: string, input: Record<string, unknown> = {}) => ({ type: 'tool_use', id, name, input, caller: null })
const progress = (text: string) => ({ type: 'thinking', thinking: text, signature: 'sig' })

function makeDeps(shareCents: number) {
  const calls: string[] = []
  const persisted: BetaMessageParam[][] = []
  let stored: { messages: unknown[]; progress: string[] } = { messages: [], progress: [] }
  const deps: ContestDeskDeps = {
    load: async () => ({ roomId: null, questionNumber: 2, reason: 'not answered', messages: stored.messages, progress: stored.progress }),
    getCardRecord: async () => (calls.push('card'), { question: 'Should tests live next to the code?', quote: 'Tests: mostly next to the code' }),
    getTranscriptWindow: async (_c, p) => (calls.push(`window ${p.around} ${p.secondsBefore} ${p.secondsAfter}`), [{ seq: 8, text: 'Tests: mostly next', words: wordsOf('Tests: mostly next'), tStartMs: 60_000, tEndMs: 63_000, source: 'replay', final: true }]),
    getOrder: async () => (calls.push('order'), { status: 'COMPLETED' }),
    getRefund: async () => (calls.push('refund?'), null),
    getShare: async () => (calls.push('share'), { shareCents }),
    refund: async (_c, p) => (calls.push(`refund ${p.finding} ${p.amountCents}`), { refundId: 'RF-1', status: 'COMPLETED', amountCents: p.amountCents }),
    requestCreatorApproval: async (_c, p) => void calls.push(`pending ${p.finding} ${p.amountCents}`),
    uphold: async () => void calls.push('uphold'),
    persist: async (_c, p) => {
      persisted.push(JSON.parse(JSON.stringify(p.messages)))
      stored = { messages: p.messages, progress: p.progress }
    },
  }
  return { deps, calls, persisted, stored: () => stored }
}

const investigate: FakeStep = {
  content: [progress('Checking the card and transcript.'), toolUse('t1', 'get_card_record'), toolUse('t2', 'get_transcript_window', { around: 'answer', seconds_before: 999, seconds_after: 30 })],
  stop: 'tool_use',
}

describe('runContestDesk', () => {
  it('refunds a deferred $3 share automatically; the amount comes from deps, not the model', async () => {
    const client = scriptedClient([
      investigate,
      { content: [toolUse('t3', 'refund_contested_share', { finding: 'deferred', evidence: "let's do testing properly next week", explanation: 'The answer was put off.', amount: 99999 })], stop: 'tool_use' },
    ])
    setAnthropicClientForTests(client)
    const { deps, calls, persisted, stored } = makeDeps(300)
    const out = await runContestDesk({ contestId: 'ct1' }, deps)
    expect(out).toMatchObject({ state: 'refunded', finding: 'deferred', refundId: 'RF-1', refundCents: 300, turns: 2 })
    expect(calls).toEqual(['card', 'window answer 300 30', 'share', 'refund deferred 300'])
    expect(stored().progress).toContain('Checking the card and transcript.')
    // Append-only: each persisted history starts with the previous one, and requests replay it unchanged.
    for (let i = 1; i < persisted.length; i++) expect(persisted[i]!.slice(0, persisted[i - 1]!.length)).toEqual(persisted[i - 1])
    expect(client.requests[1]!.messages.slice(0, 1)).toEqual(client.requests[0]!.messages)
    const last = persisted.at(-1)!
    expect(last.at(-1)!.role).toBe('user') // the decision's tool_result is stored too
    // Settings from the claude-api skill: Opus 5.5, medium effort, adaptive thinking with progress updates, auto tool choice.
    const r = client.requests[0]!
    expect(r.model).toBe('claude-opus-5-5')
    expect(r.output_config?.effort).toBe('medium')
    expect(r.thinking).toEqual({ type: 'adaptive', display: 'updates' })
    expect(r.tool_choice).toEqual({ type: 'auto' })
    expect(r.fallbacks).toBe('default')
  })

  it('sends partially_answered and large shares to the creator', async () => {
    setAnthropicClientForTests(scriptedClient([{ content: [toolUse('t1', 'refund_contested_share', { finding: 'partially_answered', evidence: 'e', explanation: 'x' })], stop: 'tool_use' }]))
    const a = makeDeps(300)
    expect((await runContestDesk({ contestId: 'ct1' }, a.deps)).state).toBe('pending_creator')
    expect(a.calls).toContain('pending partially_answered 300')
    setAnthropicClientForTests(scriptedClient([{ content: [toolUse('t1', 'refund_contested_share', { finding: 'not_answered', evidence: 'e', explanation: 'x' })], stop: 'tool_use' }]))
    const b = makeDeps(600)
    expect(await runContestDesk({ contestId: 'ct1' }, b.deps)).toMatchObject({ state: 'pending_creator', refundCents: 600 })
    expect(b.calls).not.toContain('refund not_answered 600')
  })

  it('upholds, allows only one decision per run, and answers every tool_use', async () => {
    const client = scriptedClient([
      {
        content: [toolUse('t1', 'uphold_charge', { evidence: 'one router file per feature', explanation: 'It was answered.' }), toolUse('t2', 'refund_contested_share', { finding: 'not_answered', evidence: 'e', explanation: 'x' })],
        stop: 'tool_use',
      },
    ])
    setAnthropicClientForTests(client)
    const { deps, calls, stored } = makeDeps(300)
    expect(await runContestDesk({ contestId: 'ct1' }, deps)).toMatchObject({ state: 'upheld', finding: 'answered' })
    expect(calls).toEqual(['uphold'])
    const results = (stored().messages.at(-1) as BetaMessageParam).content as { type: string; tool_use_id: string; is_error?: boolean }[]
    expect(results.map((r) => r.tool_use_id)).toEqual(['t1', 't2'])
    expect(results[1]!.is_error).toBe(true)
  })

  it('nudges once when the model ends without a decision, and stops at the turn cap', async () => {
    setAnthropicClientForTests(scriptedClient([{ text: 'I think it was answered.' }]))
    const { deps, stored } = makeDeps(300)
    const out = await runContestDesk({ contestId: 'ct1' }, deps, { maxTurns: 3 })
    expect(out).toMatchObject({ state: 'failed', turns: 3 })
    const users = stored().messages.filter((m) => (m as BetaMessageParam).role === 'user')
    expect(users).toHaveLength(4) // opening + one nudge per turn
  })

  it('fails safely on API errors and on refusals', async () => {
    setAnthropicClientForTests(scriptedClient([{ throw: new Error('down') }]))
    expect((await runContestDesk({ contestId: 'ct1' }, makeDeps(300).deps)).state).toBe('failed')
    setAnthropicClientForTests(scriptedClient([{ text: '', stop: 'refusal' }]))
    expect((await runContestDesk({ contestId: 'ct1' }, makeDeps(300).deps)).state).toBe('failed')
    setAnthropicClientForTests(null)
    expect((await runContestDesk({ contestId: 'ct1' }, makeDeps(300).deps)).state).toBe('failed')
  })

  it('resumes after the creator decides by appending a new user message', async () => {
    const client = scriptedClient([
      { content: [toolUse('t1', 'refund_contested_share', { finding: 'partially_answered', evidence: 'e', explanation: 'x' })], stop: 'tool_use' },
      { text: 'The creator approved a $3.00 refund.' },
    ])
    setAnthropicClientForTests(client)
    const d = makeDeps(300)
    await runContestDesk({ contestId: 'ct1' }, d.deps)
    const before = JSON.parse(JSON.stringify(d.stored().messages))
    const out = await runContestDesk({ contestId: 'ct1', resume: { approved: true, refundId: 'RF-9' } }, d.deps)
    expect(out).toMatchObject({ state: 'refunded', refundId: 'RF-9', explanation: 'The creator approved a $3.00 refund.' })
    expect(client.requests[1]!.messages.slice(0, before.length)).toEqual(before)
  })

  it('drops blocks before a mid-output fallback marker when echoing content', () => {
    const blocks = [progress('a'), { type: 'tool_use', id: 'x', name: 'get_order', input: {} }, { type: 'text', text: 'partial' }, { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } }, { type: 'text', text: 'rest' }]
    expect(echoableContent(blocks as never).map((b) => b.type)).toEqual(['text', 'fallback', 'text'])
  })
})
