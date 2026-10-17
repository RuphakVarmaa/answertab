// LLM prices in micro-USD per million tokens, so cost math stays in integers.
// Source: the claude-api skill's model table (cached 2026-10-06) and its Haiku 5.5 / Opus 5.5 migration notes,
// read 2026-10-16. Re-check the published price page before quoting numbers externally.
//   Haiku 5.5: $0.10 in / $0.50 out per MTok (prompts <= 100K tokens; $0.50 / $2.50 above),
//              cache read 0.1x input, 5-minute cache write 1.25x input.
//   Opus 5.5:  $4 in / $20 out, cache read $0.20, 5-minute cache write $5.
//   Opus 5 / Opus 4.8 (possible server-side fallback targets for Opus 5.5): $5 / $25, cache read 0.1x, write 1.25x.

export interface RateCard {
  input: number
  output: number
  cacheWrite5m: number
  cacheRead: number
}

interface ModelPrice {
  base: RateCard
  /** Higher rate card for prompts above `longPromptTokens` (Haiku 5.5 only). */
  long?: { aboveTokens: number; card: RateCard }
}

const M = 1_000_000 // micro-USD per USD

export const PRICES: Record<string, ModelPrice> = {
  'claude-haiku-5-5': {
    base: { input: 0.1 * M, output: 0.5 * M, cacheWrite5m: 0.125 * M, cacheRead: 0.01 * M },
    long: { aboveTokens: 100_000, card: { input: 0.5 * M, output: 2.5 * M, cacheWrite5m: 0.625 * M, cacheRead: 0.05 * M } },
  },
  'claude-opus-5-5': { base: { input: 4 * M, output: 20 * M, cacheWrite5m: 5 * M, cacheRead: 0.2 * M } },
  'claude-opus-5': { base: { input: 5 * M, output: 25 * M, cacheWrite5m: 6.25 * M, cacheRead: 0.5 * M } },
  'claude-opus-4-8': { base: { input: 5 * M, output: 25 * M, cacheWrite5m: 6.25 * M, cacheRead: 0.5 * M } },
}

export const HAIKU = 'claude-haiku-5-5'
export const OPUS = 'claude-opus-5-5'

export interface TokenUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
}

/** Unknown models are priced at the most expensive known card, so budgets err on the safe side. */
function priceFor(model: string): ModelPrice {
  const exact = PRICES[model]
  if (exact) return exact
  const prefix = Object.keys(PRICES).find((k) => model.startsWith(k))
  if (prefix) return PRICES[prefix]!
  return PRICES['claude-opus-5']!
}

/** Cost of one attempt in micro-USD, rounded up to a whole micro. */
export function costMicros(model: string, u: TokenUsage): number {
  const p = priceFor(model)
  const write = u.cache_creation_input_tokens ?? 0
  const read = u.cache_read_input_tokens ?? 0
  const promptTokens = u.input_tokens + write + read
  const card = p.long && promptTokens > p.long.aboveTokens ? p.long.card : p.base
  const microTokens =
    u.input_tokens * card.input + u.output_tokens * card.output + write * card.cacheWrite5m + read * card.cacheRead
  return Math.ceil(microTokens / 1_000_000)
}

/** Sum over `usage.iterations` when present (server-side fallbacks bill every attempt), else top-level usage. */
export function messageCostMicros(
  model: string,
  usage: TokenUsage & { iterations?: ({ model?: string | null; type: string } & Partial<TokenUsage>)[] | null },
): number {
  const its = usage.iterations
  if (its && its.length > 0) {
    let sum = 0
    for (const it of its) {
      if (typeof it.input_tokens !== 'number' || typeof it.output_tokens !== 'number') continue
      sum += costMicros(it.model ?? model, it as TokenUsage)
    }
    if (sum > 0) return sum
  }
  return costMicros(model, usage)
}

/** Upper bound of a call's output cost (max_tokens at the output rate), for budget reservations. */
export function maxOutputMicros(model: string, maxTokens: number): number {
  return Math.ceil((Math.max(0, maxTokens) * priceFor(model).base.output) / 1_000_000)
}
