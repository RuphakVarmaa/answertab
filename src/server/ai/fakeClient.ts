// Scripted stand-in for the Anthropic client, for tests and offline demos. Never used unless injected
// with setAnthropicClientForTests().
import type { ClaudeClient, ClaudeMessage, CreateParams } from './anthropic.js'

export type FakeStep =
  | { text: string; stop?: ClaudeMessage['stop_reason']; usage?: Partial<ClaudeMessage['usage']> }
  | { content: unknown[]; stop?: ClaudeMessage['stop_reason']; usage?: Partial<ClaudeMessage['usage']> }
  | { throw: unknown }

export function fakeMessage(step: Exclude<FakeStep, { throw: unknown }>, model = 'claude-haiku-5-5'): ClaudeMessage {
  const content = 'text' in step ? [{ type: 'text', text: step.text, citations: null }] : step.content
  return {
    id: 'msg_fake',
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: step.stop ?? 'end_turn',
    stop_sequence: null,
    stop_details: null,
    container: null,
    context_management: null,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: null,
      inference_geo: null,
      iterations: null,
      server_tool_use: null,
      service_tier: 'standard',
      ...step.usage,
    },
  } as unknown as ClaudeMessage
}

/** Replays `steps` in order (the last one repeats) and records every request. */
export function scriptedClient(steps: FakeStep[]): ClaudeClient & { requests: CreateParams[] } {
  const requests: CreateParams[] = []
  let i = 0
  return {
    requests,
    async create(params) {
      // Snapshot: callers keep appending to the same messages array.
      requests.push(JSON.parse(JSON.stringify(params)) as CreateParams)
      const step = steps[Math.min(i++, steps.length - 1)]!
      if ('throw' in step) throw step.throw
      return fakeMessage(step, params.model)
    },
  }
}
