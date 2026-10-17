// Demo replay indicator, derived from room state only (no timers): the bots' holds, the replay segments the
// director has posted, and whether a card is still being checked. Pure, so it is testable in node.
import type { QuestionView, RoomStatus, Segment, TabView } from '../../shared/types.js'

/**
 * Spoken lines in the judge-mode replay (src/server/demo/script.ts DEMO_SCRIPT: deflection, answer, partial).
 * Keep in step with the script.
 */
export const REPLAY_LINES = 3
/** A replay that has posted nothing for this long on the room clock is treated as finished (director stopped early). */
export const REPLAY_STALL_MS = 25_000

export type ReplayPhase = 'idle' | 'holds' | 'waiting' | 'playing' | 'checking' | 'done' | 'finished'

export interface ReplayProgress {
  phase: ReplayPhase
  label: string
  /** Replay lines posted so far, out of REPLAY_LINES. */
  step: number
  total: number
  /** The bars animate. */
  active: boolean
}

export interface ReplayInput {
  status: RoomStatus
  segments: readonly Pick<Segment, 'source' | 'final' | 'tEndMs'>[]
  tabs: readonly (Pick<TabView, 'state'> & { isBot?: boolean })[]
  questions: readonly Pick<QuestionView, 'state'>[]
  /** Replay text is arriving right now (segment.interim). */
  interim: boolean
  /** Room clock now (ms since clockStartedAt), or null before the room starts. */
  clockMs: number | null
}

export function replayProgress(p: ReplayInput): ReplayProgress {
  const total = REPLAY_LINES
  const replay = p.segments.filter((s) => s.source === 'replay' && s.final)
  const step = Math.min(total, replay.length)
  const base = { step, total }
  if (p.status === 'draft') return { ...base, phase: 'idle', label: 'Replay', active: false }
  if (p.status !== 'live') return { ...base, phase: 'finished', label: step > 0 ? 'Replay finished' : 'Replay', active: false }

  const checking = p.questions.some((q) => q.state === 'verifying')
  if (step === 0) {
    if (p.interim) return { ...base, phase: 'playing', label: `Replay 1/${total} playing`, active: true }
    const bots = p.tabs.filter((t) => t.isBot)
    const opening = bots.length === 0 || bots.some((t) => t.state === 'opening')
    return opening
      ? { ...base, phase: 'holds', label: 'Bots placing holds…', active: true }
      : { ...base, phase: 'waiting', label: 'Replay starting', active: true }
  }

  const lastEnd = Math.max(...replay.map((s) => s.tEndMs))
  const stalled = p.clockMs !== null && p.clockMs - lastEnd > REPLAY_STALL_MS
  if (step >= total || stalled) {
    if (checking && !stalled) return { ...base, phase: 'checking', label: 'Replay done — Claude is checking', active: true }
    return { ...base, phase: 'done', label: 'Replay done — your turn', active: false }
  }
  if (p.interim) return { ...base, phase: 'playing', label: `Replay ${step + 1}/${total} playing`, active: true }
  if (checking) return { ...base, phase: 'checking', label: `Replay ${step}/${total} — Claude is checking`, active: true }
  return { ...base, phase: 'playing', label: `Replay ${step}/${total}`, active: true }
}
