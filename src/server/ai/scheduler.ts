// Per-room detector scheduling: a call on a final segment when the prefilter hits, plus a sweep at most
// every 20 s while transcript keeps flowing. One call in flight per room; triggers that arrive meanwhile
// coalesce into a single follow-up run over the newest window.
import type { Segment, Verdict } from '../../shared/types.js'
import { detectAnswers } from './detector.js'
import { prefilterHit } from './prefilter.js'
import type { OpenQ } from './types.js'

export interface SchedulerClock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const realClock: SchedulerClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

export type Trigger = 'cue' | 'sweep' | 'manual'

export interface DetectorRun {
  verdicts: Verdict[]
  openQuestions: OpenQ[]
  window: Segment[]
  trigger: Trigger
}

export interface DetectorSchedulerOptions {
  roomId: string
  onVerdicts: (run: DetectorRun) => void | Promise<void>
  detect?: (p: { roomId: string; openQuestions: OpenQ[]; window: Segment[] }) => Promise<Verdict[]>
  onError?: (e: unknown) => void
  clock?: SchedulerClock
  sweepEveryMs?: number
  /** Window length on the room clock. */
  windowMs?: number
  maxSegments?: number
  prefilterLookbackMs?: number
  /** Return false to pause (manual mode, budget hit). */
  enabled?: () => boolean
}

export class DetectorScheduler {
  private readonly o: Required<Omit<DetectorSchedulerOptions, 'onError' | 'enabled'>> &
    Pick<DetectorSchedulerOptions, 'onError' | 'enabled'>
  private segments: Segment[] = []
  private openQuestions: OpenQ[] = []
  private inFlight: Promise<void> | null = null
  private running = false
  private pending: Trigger | null = null
  private timer: unknown = null
  private lastRunAt: number | null = null
  private flowSinceRun = false
  private stopped = false
  /** Number of detector calls started (for tests and /status). */
  calls = 0

  constructor(opts: DetectorSchedulerOptions) {
    this.o = {
      detect: detectAnswers,
      clock: realClock,
      sweepEveryMs: 20_000,
      windowMs: 90_000,
      maxSegments: 40,
      prefilterLookbackMs: 60_000,
      ...opts,
    }
  }

  /** The domain calls this whenever the open set changes (new, locked, hidden, undone). */
  setOpenQuestions(qs: OpenQ[]): void {
    this.openQuestions = [...qs]
  }

  /** Feed every final segment. Interim segments are ignored (they never lock). */
  onSegment(seg: Segment): void {
    if (this.stopped || !seg.final) return
    this.segments = this.segments.filter((s) => s.seq !== seg.seq)
    this.segments.push(seg)
    this.segments.sort((a, b) => a.seq - b.seq)
    const newest = Math.max(...this.segments.map((s) => s.tEndMs))
    this.segments = this.segments.filter((s) => s.tEndMs >= newest - this.o.windowMs * 2)
    this.flowSinceRun = true
    if (this.lastRunAt === null) this.lastRunAt = this.o.clock.now()
    if (this.openQuestions.length === 0 || !this.isEnabled()) return
    const hit = prefilterHit({ segments: this.segments, openQuestions: this.openQuestions, lookbackMs: this.o.prefilterLookbackMs })
    if (hit.hit) this.trigger('cue')
    else this.armSweep()
  }

  /** Runs now (or right after the call in flight). */
  trigger(reason: Trigger): void {
    if (this.stopped || !this.isEnabled()) return
    if (this.running) {
      if (this.pending !== 'cue') this.pending = reason
      return
    }
    this.clearTimer()
    this.running = true
    this.inFlight = this.loop(reason)
  }

  /** Resolves when no call is in flight and nothing is pending (tests). */
  async idle(): Promise<void> {
    while (this.running && this.inFlight) await this.inFlight
  }

  stop(): void {
    this.stopped = true
    this.clearTimer()
  }

  currentWindow(): Segment[] {
    if (this.segments.length === 0) return []
    const newest = Math.max(...this.segments.map((s) => s.tEndMs))
    return this.segments.filter((s) => s.tEndMs >= newest - this.o.windowMs).slice(-this.o.maxSegments)
  }

  private isEnabled(): boolean {
    return this.o.enabled ? this.o.enabled() : true
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.o.clock.clearTimeout(this.timer)
      this.timer = null
    }
  }

  private armSweep(): void {
    if (this.timer !== null || this.running || this.stopped) return
    const due = (this.lastRunAt ?? this.o.clock.now()) + this.o.sweepEveryMs
    const delay = Math.max(0, due - this.o.clock.now())
    this.timer = this.o.clock.setTimeout(() => {
      this.timer = null
      if (this.flowSinceRun) this.trigger('sweep')
    }, delay)
  }

  private async loop(first: Trigger): Promise<void> {
    await null // let trigger() store the promise before any synchronous completion
    let reason: Trigger | null = first
    try {
      while (reason) {
        await this.runOnce(reason)
        reason = this.pending
        this.pending = null
        if (this.stopped || !this.isEnabled()) reason = null
      }
    } finally {
      this.running = false
      this.inFlight = null
      if (this.flowSinceRun) this.armSweep()
    }
  }

  private async runOnce(reason: Trigger): Promise<void> {
    this.calls++
    this.flowSinceRun = false
    this.lastRunAt = this.o.clock.now()
    const openQuestions = [...this.openQuestions]
    const window = this.currentWindow()
    if (openQuestions.length === 0 || window.length === 0) return
    try {
      const verdicts = await this.o.detect({ roomId: this.o.roomId, openQuestions, window })
      await this.o.onVerdicts({ verdicts, openQuestions, window, trigger: reason })
    } catch (e) {
      this.o.onError?.(e)
    }
  }
}
