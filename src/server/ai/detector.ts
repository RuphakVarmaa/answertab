// Live answer detector (Haiku 5.5). Never throws: any failure returns [] and the caller routes to review/manual.
import type { Segment, Verdict, VerdictKind } from '../../shared/types.js'
import { callClaude, textOf, type CallOutcome } from './anthropic.js'
import { buildDetectorRequest, DEFAULT_DETECTOR_SETTINGS, type DetectorSettings } from './prompts/detector.js'
import type { AiTroubleReason, OpenQ } from './types.js'

const VERDICTS: ReadonlySet<string> = new Set(['answered', 'partial', 'deflected', 'already_covered', 'not_yet'])

export interface DetectInput {
  roomId: string | null
  openQuestions: OpenQ[]
  window: Segment[]
}

export interface DetectDetail {
  verdicts: Verdict[]
  ok: boolean
  reason?: AiTroubleReason | 'empty'
  latencyMs: number
  costMicros: number
  usage?: { input: number; cacheRead: number; cacheWrite: number; output: number }
  requestId?: string | null
}

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n)

/**
 * Parses and validates the structured output. Drops entries for numbers outside the open set, bad enums,
 * and malformed spans (span becomes null). Keeps the highest-confidence entry per question.
 * Returns null when the text is not the expected JSON shape at all.
 */
export function parseDetectorOutput(text: string, openNumbers: ReadonlySet<number>): Verdict[] | null {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  const list = (data as { verdicts?: unknown })?.verdicts
  if (!Array.isArray(list)) return null
  const best = new Map<number, Verdict>()
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const n = r.question_number
    if (!isInt(n) || !openNumbers.has(n)) continue
    if (typeof r.verdict !== 'string' || !VERDICTS.has(r.verdict)) continue
    const c = typeof r.confidence === 'number' && Number.isFinite(r.confidence) ? Math.min(1, Math.max(0, r.confidence)) : 0
    let evidence: Verdict['evidence'] = null
    const e = r.evidence as Record<string, unknown> | null | undefined
    if (e && isInt(e.start_seg) && isInt(e.start_word) && isInt(e.end_seg) && isInt(e.end_word)) {
      evidence = { startSeg: e.start_seg, startWord: e.start_word, endSeg: e.end_seg, endWord: e.end_word }
    }
    const v: Verdict = { questionNumber: n, verdict: r.verdict as VerdictKind, evidence, confidence: c }
    const prev = best.get(n)
    if (!prev || v.confidence > prev.confidence) best.set(n, v)
  }
  return [...best.values()].sort((a, b) => a.questionNumber - b.questionNumber)
}

/** Final segments from the last `maxMs` of room time (by the newest segment's end), capped by count. */
export function selectWindow(segments: Segment[], opts: { maxMs?: number; maxSegments?: number } = {}): Segment[] {
  const maxMs = opts.maxMs ?? 90_000
  const maxSegments = opts.maxSegments ?? 40
  const finals = segments.filter((s) => s.final).sort((a, b) => a.seq - b.seq)
  if (finals.length === 0) return []
  const newest = Math.max(...finals.map((s) => s.tEndMs))
  return finals.filter((s) => s.tEndMs >= newest - maxMs).slice(-maxSegments)
}

export interface DetectOptions {
  settings?: DetectorSettings
  timeoutMs?: number
  /** Eval runs: skip budget and audit rows. */
  offline?: boolean
}

export async function detectAnswersDetailed(p: DetectInput, opts: DetectOptions = {}): Promise<DetectDetail> {
  const window = p.window.filter((s) => s.final)
  if (p.openQuestions.length === 0 || window.length === 0) {
    return { verdicts: [], ok: true, reason: 'empty', latencyMs: 0, costMicros: 0 }
  }
  const settings = opts.settings ?? DEFAULT_DETECTOR_SETTINGS
  const params = buildDetectorRequest(p.openQuestions, window, settings)
  const open = new Set(p.openQuestions.map((q) => q.number))
  let parsed: Verdict[] | null = null
  const out: CallOutcome = await callClaude(params, {
    roomId: p.roomId,
    purpose: 'detect',
    estMicros: 3_000,
    timeoutMs: opts.timeoutMs ?? 12_000,
    maxRetries: 1,
    offline: opts.offline,
    summarize: (m) => {
      parsed = parseDetectorOutput(textOf(m), open)
      return parsed ?? { unparsed: true }
    },
  })
  const usage = out.message
    ? {
        input: out.message.usage.input_tokens,
        cacheRead: out.message.usage.cache_read_input_tokens ?? 0,
        cacheWrite: out.message.usage.cache_creation_input_tokens ?? 0,
        output: out.message.usage.output_tokens,
      }
    : undefined
  if (!out.ok) return { verdicts: [], ok: false, reason: out.reason, latencyMs: out.latencyMs, costMicros: out.costMicros, usage }
  const verdicts: Verdict[] | null = parsed ?? parseDetectorOutput(textOf(out.message), open)
  if (!verdicts) {
    return { verdicts: [], ok: false, reason: 'bad_output', latencyMs: out.latencyMs, costMicros: out.costMicros, usage, requestId: out.requestId }
  }
  return { verdicts, ok: true, latencyMs: out.latencyMs, costMicros: out.costMicros, usage, requestId: out.requestId }
}

/** ARCHITECTURE API: never throws; [] on any failure (the audit row and trouble listener record why). */
export async function detectAnswers(p: { roomId: string; openQuestions: OpenQ[]; window: Segment[] }): Promise<Verdict[]> {
  try {
    return (await detectAnswersDetailed(p)).verdicts
  } catch {
    return []
  }
}
