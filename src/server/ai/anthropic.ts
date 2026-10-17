// Lazy Anthropic client plus one wrapper for every model call: budget pre-check, timing, cost from usage,
// an audit row in `detections`, and budget recording. It never throws and never logs prompts or secrets.
import { createHash } from 'node:crypto'
import Anthropic from '@anthropic-ai/sdk'
import type { BetaMessage, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages.js'
import type { BudgetPool } from '../../shared/types.js'
import { config } from '../config.js'
import { db } from '../db/db.js'
import { newId } from '../ids.js'
import { budget, type Reservation } from './budget.js'
import { aiLog } from './log.js'
import { maxOutputMicros, messageCostMicros } from './pricing.js'
import type { AiTroubleReason, CallPurpose } from './types.js'

export type CreateParams = MessageCreateParamsNonStreaming
export type ClaudeMessage = BetaMessage

/** The one SDK surface we use. Tests inject a fake with this shape. */
export interface ClaudeClient {
  create(params: CreateParams, options: { timeout: number; maxRetries: number; signal?: AbortSignal }): Promise<ClaudeMessage>
}

let client: ClaudeClient | null | undefined

function readApiKey(): string | null {
  try {
    return config().anthropicApiKey
  } catch {
    return process.env.ANTHROPIC_API_KEY || null
  }
}

/** Null when ANTHROPIC_API_KEY is missing; callers then fall back to manual mode. */
export function anthropicClient(): ClaudeClient | null {
  if (client !== undefined) return client
  const apiKey = readApiKey()
  if (!apiKey) {
    client = null
    return client
  }
  const sdk = new Anthropic({ apiKey, maxRetries: 1 })
  client = { create: (params, options) => sdk.beta.messages.create(params, options) }
  return client
}

export function aiEnabled(): boolean {
  return anthropicClient() !== null
}

/** Tests only: inject a fake client (null = no key). `undefined` resets to lazy env loading. */
export function setAnthropicClientForTests(c: ClaudeClient | null | undefined): void {
  client = c
}

export type TroubleListener = (e: { roomId: string | null; purpose: CallPurpose; reason: AiTroubleReason; detail: string }) => void
let troubleListener: TroubleListener | null = null

/** The domain layer subscribes to switch a room to manual confirm on budget hits and API failures. */
export function setAiTroubleListener(fn: TroubleListener | null): void {
  troubleListener = fn
}

export function reportTrouble(roomId: string | null, purpose: CallPurpose, reason: AiTroubleReason, detail: string): void {
  aiLog.warn({ roomId, purpose, reason, detail }, 'ai call unusable')
  try {
    troubleListener?.({ roomId, purpose, reason, detail })
  } catch {
    // a listener bug must not break the AI path
  }
}

export interface CallOptions {
  roomId: string | null
  purpose: CallPurpose
  /** Room pool; looked up from `rooms` when omitted and roomId is set. */
  pool?: BudgetPool
  /** Pre-call estimate for the budget check, in micro-USD. */
  estMicros: number
  timeoutMs: number
  maxRetries?: number
  /** What to store in detections.output (no transcript text). Defaults to stop reason only. */
  summarize?: (m: ClaudeMessage) => unknown
  /** Skip budget + audit (eval runs). */
  offline?: boolean
}

export type CallOutcome =
  | { ok: true; message: ClaudeMessage; costMicros: number; latencyMs: number; requestId: string | null }
  | { ok: false; reason: AiTroubleReason; detail: string; costMicros: number; latencyMs: number; message?: ClaudeMessage }

const poolCache = new Map<string, BudgetPool>()

async function roomPool(roomId: string): Promise<BudgetPool | null> {
  const hit = poolCache.get(roomId)
  if (hit) return hit
  const rows = await db().query<{ pool: BudgetPool }>(`SELECT pool FROM rooms WHERE id = $1`, [roomId])
  const pool = rows[0]?.pool ?? null
  if (pool) poolCache.set(roomId, pool)
  return pool
}

function dbAvailable(): boolean {
  try {
    db()
    return true
  } catch {
    return false
  }
}

function classifyError(e: unknown): { reason: AiTroubleReason; detail: string } {
  if (e instanceof Anthropic.APIConnectionTimeoutError) return { reason: 'timeout', detail: 'timeout' }
  if (e instanceof Anthropic.APIConnectionError) return { reason: 'connection', detail: 'connection error' }
  if (e instanceof Anthropic.RateLimitError) return { reason: 'rate_limit', detail: 'HTTP 429' }
  if (e instanceof Anthropic.APIError) {
    const type = (e.error as { error?: { type?: string } } | undefined)?.error?.type ?? 'error'
    return { reason: 'api_error', detail: `HTTP ${e.status ?? '?'} ${type}` }
  }
  if (e instanceof Error && e.name === 'AbortError') return { reason: 'timeout', detail: 'aborted' }
  return { reason: 'api_error', detail: e instanceof Error ? e.name : 'unknown error' }
}

function digest(params: CreateParams): string {
  return createHash('sha256').update(JSON.stringify(params)).digest('hex').slice(0, 32)
}

async function audit(row: {
  roomId: string | null
  purpose: CallPurpose
  model: string
  message?: ClaudeMessage
  costMicros: number
  latencyMs: number
  ok: boolean
  output: unknown
  error: string | null
}): Promise<void> {
  if (!dbAvailable()) return
  const u = row.message?.usage
  try {
    await db().query(
      `INSERT INTO detections (id, room_id, purpose, model, input_tokens, output_tokens, cache_read_tokens, cost_micros, latency_ms, ok, output, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        newId('det'),
        row.roomId,
        row.purpose,
        row.model,
        u ? u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) : null,
        u?.output_tokens ?? null,
        u?.cache_read_input_tokens ?? null,
        row.costMicros,
        row.latencyMs,
        row.ok,
        JSON.stringify(row.output ?? null),
        row.error,
      ],
    )
  } catch (e) {
    aiLog.warn({ purpose: row.purpose, err: e instanceof Error ? e.message.slice(0, 120) : 'unknown' }, 'audit insert failed')
  }
}

/**
 * Runs one Messages API call. Returns ok:false (never throws) on: no client, budget exhausted, API errors,
 * timeouts, refusals and max_tokens stops. Callers decide what an unusable result means (usually review/manual).
 */
export async function callClaude(params: CreateParams, opts: CallOptions): Promise<CallOutcome> {
  const c = anthropicClient()
  if (!c) return { ok: false, reason: 'no_client', detail: 'ANTHROPIC_API_KEY not set', costMicros: 0, latencyMs: 0 }

  let pool: BudgetPool | null = null
  let reservation: Reservation | null = null
  if (!opts.offline && dbAvailable()) {
    try {
      pool = opts.pool ?? (opts.roomId ? await roomPool(opts.roomId) : null)
      if (pool) {
        // Reserve the worst case (at least the full max_tokens of output) before calling, atomically, so
        // concurrent calls (e.g. several contest desks) cannot all pass the same cap check.
        const est = Math.max(opts.estMicros, maxOutputMicros(params.model, params.max_tokens))
        reservation = await budget.reserve(opts.roomId, pool, est)
        if (!reservation) {
          reportTrouble(opts.roomId, opts.purpose, 'budget', 'LLM budget cap reached')
          return { ok: false, reason: 'budget', detail: 'LLM budget cap reached', costMicros: 0, latencyMs: 0 }
        }
      }
    } catch (e) {
      // A budget lookup failure must not silently allow unlimited spend: treat it as a cap hit.
      aiLog.warn({ purpose: opts.purpose, err: e instanceof Error ? e.message.slice(0, 120) : 'unknown' }, 'budget check failed')
      reportTrouble(opts.roomId, opts.purpose, 'budget', 'budget check failed')
      return { ok: false, reason: 'budget', detail: 'budget check failed', costMicros: 0, latencyMs: 0 }
    }
  }

  const started = performance.now()
  let message: ClaudeMessage
  try {
    message = await c.create(params, { timeout: opts.timeoutMs, maxRetries: opts.maxRetries ?? 1 })
  } catch (e) {
    const latencyMs = Math.round(performance.now() - started)
    const { reason, detail } = classifyError(e)
    if (reservation) await budget.settleReservation(reservation, 0).catch(() => {})
    if (!opts.offline) {
      await audit({ roomId: opts.roomId, purpose: opts.purpose, model: params.model, costMicros: 0, latencyMs, ok: false, output: { inputDigest: digest(params) }, error: detail })
    }
    reportTrouble(opts.roomId, opts.purpose, reason, detail)
    return { ok: false, reason, detail, costMicros: 0, latencyMs }
  }
  const latencyMs = Math.round(performance.now() - started)
  const cost = messageCostMicros(message.model ?? params.model, message.usage)
  const stop = message.stop_reason
  const unusable: AiTroubleReason | null = stop === 'refusal' ? 'refusal' : stop === 'max_tokens' ? 'max_tokens' : null
  const requestId = (message as { _request_id?: string | null })._request_id ?? null

  aiLog.info(
    {
      purpose: opts.purpose,
      roomId: opts.roomId,
      model: message.model,
      stop,
      in: message.usage.input_tokens,
      cacheRead: message.usage.cache_read_input_tokens ?? 0,
      cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
      out: message.usage.output_tokens,
      costMicros: cost,
      latencyMs,
      requestId,
    },
    'claude call',
  )

  if (!opts.offline) {
    let summary: unknown = null
    try {
      summary = opts.summarize ? opts.summarize(message) : null
    } catch {
      summary = null
    }
    await audit({
      roomId: opts.roomId,
      purpose: opts.purpose,
      model: message.model ?? params.model,
      message,
      costMicros: cost,
      latencyMs,
      ok: unusable === null,
      output: {
        inputDigest: digest(params),
        stopReason: stop,
        cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
        requestId,
        result: summary,
      },
      error: unusable,
    })
    if (reservation) {
      try {
        await budget.settleReservation(reservation, cost)
      } catch (e) {
        aiLog.warn({ purpose: opts.purpose, err: e instanceof Error ? e.message.slice(0, 120) : 'unknown' }, 'budget record failed')
      }
    }
  }

  if (unusable) {
    const detail = unusable === 'refusal' ? `refusal (${message.stop_details?.category ?? 'no category'})` : 'max_tokens stop'
    reportTrouble(opts.roomId, opts.purpose, unusable, detail)
    return { ok: false, reason: unusable, detail, costMicros: cost, latencyMs, message }
  }
  return { ok: true, message, costMicros: cost, latencyMs, requestId }
}

/** Concatenated text blocks (thinking blocks skipped). */
export function textOf(m: ClaudeMessage): string {
  let out = ''
  for (const b of m.content) if (b.type === 'text') out += b.text
  return out
}
