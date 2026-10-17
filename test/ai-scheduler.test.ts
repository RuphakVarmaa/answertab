import { describe, expect, it } from 'vitest'
import type { Segment, Verdict } from '../src/shared/types.js'
import { prefilterHit } from '../src/server/ai/prefilter.js'
import { DetectorScheduler, type SchedulerClock } from '../src/server/ai/scheduler.js'
import { wordsOf } from '../src/server/ai/text.js'
import type { OpenQ } from '../src/server/ai/types.js'

const seg = (seq: number, tStartMs: number, text: string, final = true): Segment => ({
  seq,
  text,
  words: wordsOf(text),
  tStartMs,
  tEndMs: tStartMs + 3000,
  source: 'spoken',
  final,
})
const qs: OpenQ[] = [
  { number: 1, text: 'How should I split a big API project into folders?', askedAtMs: 0, cues: ['router file'] },
  { number: 2, text: 'Should tests live next to the code?', askedAtMs: 0 },
]

describe('prefilterHit', () => {
  it('hits on generic answer and deflection phrases', () => {
    for (const t of ['okay someone asked about this', 'Great question, hold that thought', 'about your question, yes']) {
      expect(prefilterHit({ segments: [seg(1, 0, t)], openQuestions: qs }).hit).toBe(true)
    }
  })
  it('hits on intake cues, question numbers and shared content words', () => {
    expect(prefilterHit({ segments: [seg(1, 0, 'one ROUTER file each')], openQuestions: qs }).reason).toContain('cue')
    expect(prefilterHit({ segments: [seg(1, 0, 'moving to question two now')], openQuestions: qs }).reason).toContain('number 2')
    expect(prefilterHit({ segments: [seg(1, 0, 'tests mostly live beside it')], openQuestions: qs }).reason).toContain('overlap with Q2')
  })
  it('misses unrelated talk, and only looks at the last ~60 s', () => {
    expect(prefilterHit({ segments: [seg(1, 0, 'the weather is lovely today')], openQuestions: qs }).hit).toBe(false)
    const old = seg(1, 0, 'great question about folders')
    const now = seg(2, 120_000, 'the weather is lovely today')
    expect(prefilterHit({ segments: [old, now], openQuestions: qs }).hit).toBe(false)
    expect(prefilterHit({ segments: [seg(1, 0, 'great question')], openQuestions: [] }).hit).toBe(false)
  })
  it('ignores interim segments', () => {
    expect(prefilterHit({ segments: [seg(1, 0, 'great question', false)], openQuestions: qs }).hit).toBe(false)
  })
})

class FakeClock implements SchedulerClock {
  t = 0
  timers: { at: number; fn: () => void; id: number }[] = []
  private next = 1
  now() {
    return this.t
  }
  setTimeout(fn: () => void, ms: number) {
    const id = this.next++
    this.timers.push({ at: this.t + ms, fn, id })
    return id
  }
  clearTimeout(h: unknown) {
    this.timers = this.timers.filter((x) => x.id !== h)
  }
  advance(ms: number) {
    const end = this.t + ms
    for (;;) {
      const due = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      this.timers = this.timers.filter((x) => x !== due)
      this.t = due.at
      due.fn()
    }
    this.t = end
  }
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

function setup() {
  const clock = new FakeClock()
  const calls: { window: Segment[] }[] = []
  const gates: ReturnType<typeof deferred<Verdict[]>>[] = []
  const delivered: number[] = []
  const s = new DetectorScheduler({
    roomId: 'room1',
    clock,
    detect: async (p) => {
      calls.push({ window: p.window })
      const g = deferred<Verdict[]>()
      gates.push(g)
      return g.promise
    },
    onVerdicts: (run) => {
      delivered.push(run.window.length)
    },
  })
  s.setOpenQuestions(qs)
  return { clock, calls, gates, delivered, s }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('DetectorScheduler', () => {
  it('runs on a prefilter hit and keeps one call in flight, coalescing triggers into one follow-up', async () => {
    const { calls, gates, delivered, s } = setup()
    s.onSegment(seg(1, 0, 'great question about folders'))
    await tick()
    expect(calls).toHaveLength(1)
    s.onSegment(seg(2, 3000, 'someone asked about tests'))
    s.onSegment(seg(3, 6000, 'okay to answer that'))
    s.onSegment(seg(4, 9000, 'the short answer is yes'))
    await tick()
    expect(calls).toHaveLength(1) // still in flight
    gates[0]!.resolve([])
    await tick()
    await tick()
    expect(calls).toHaveLength(2) // the three triggers became one run
    expect(calls[1]!.window.map((w) => w.seq)).toEqual([1, 2, 3, 4]) // over the newest window
    gates[1]!.resolve([])
    await s.idle()
    expect(calls).toHaveLength(2)
    expect(delivered).toEqual([1, 4])
  })

  it('sweeps at most every 20 s, and only while transcript keeps flowing', async () => {
    const { clock, calls, gates, s } = setup()
    s.onSegment(seg(1, 0, 'the weather is lovely today')) // no cue: arms a sweep
    clock.advance(19_999)
    await tick()
    expect(calls).toHaveLength(0)
    clock.advance(1)
    await tick()
    expect(calls).toHaveLength(1)
    gates[0]!.resolve([])
    await s.idle()
    clock.advance(60_000) // nothing new was said: no sweep
    await tick()
    expect(calls).toHaveLength(1)
    s.onSegment(seg(2, 70_000, 'more weather talk here'))
    clock.advance(0)
    await tick()
    expect(calls).toHaveLength(2) // last run was > 20 s ago, so the sweep is due at once
    gates[1]!.resolve([])
    await s.idle()
    s.onSegment(seg(3, 73_000, 'and some more chatter'))
    clock.advance(19_000)
    await tick()
    expect(calls).toHaveLength(2)
    clock.advance(1_000)
    await tick()
    expect(calls).toHaveLength(3)
    gates[2]!.resolve([])
    await s.idle()
  })

  it('ignores interim segments, pauses when disabled, and survives detector errors', async () => {
    const clock = new FakeClock()
    let enabled = true
    let errors = 0
    let calls = 0
    const s = new DetectorScheduler({
      roomId: 'r',
      clock,
      enabled: () => enabled,
      detect: async () => {
        calls++
        throw new Error('boom')
      },
      onVerdicts: () => {},
      onError: () => errors++,
    })
    s.setOpenQuestions(qs)
    s.onSegment(seg(1, 0, 'great question', false))
    await tick()
    expect(calls).toBe(0)
    s.onSegment(seg(2, 0, 'great question'))
    await s.idle()
    expect(calls).toBe(1)
    expect(errors).toBe(1)
    enabled = false
    s.onSegment(seg(3, 3000, 'someone asked about folders'))
    clock.advance(60_000)
    await tick()
    expect(calls).toBe(1)
  })

  it('does not call the detector without open questions', async () => {
    const clock = new FakeClock()
    let calls = 0
    const s = new DetectorScheduler({ roomId: 'r', clock, detect: async () => (calls++, []), onVerdicts: () => {} })
    s.onSegment(seg(1, 0, 'great question'))
    clock.advance(60_000)
    await tick()
    expect(calls).toBe(0)
  })
})
