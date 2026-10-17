// Replay director for demo rooms. Plays DEMO_SCRIPT (script.ts): the strip bots ask, a near-duplicate backs Q1
// instead (checkSimilar, so nothing is reserved for it), then scripted replay segments arrive: a deflection, an
// answer that locks three holds (the Opus verifier runs first: $12 from 3 backers), and a partial answer.
//
// Everything goes through the domain API, so the creator sees the progress on existing SSE events only:
// tab.updated (bot holds), question.created / backing.created (bots), segment.interim + segment.added with
// source 'replay' (the console's Replay indicator), verdict + question.updated (detector), budget.mode (manual).
//
// Timing: steps run at their scripted offsets on the room clock. Where the script needs a verdict before going on,
// the director waits on detectionIdle() and the card state, with a safety timeout. If it falls behind, the rest of
// the timeline shifts later as a block. It never ends the room: after the autoplay the judge's checklist begins.
import type { AiMode, QuestionState } from '../../shared/types.js'
import {
  DomainError,
  addSegment,
  askQuestion,
  backQuestion,
  detectionIdle,
  findFan,
  getMe,
  getQuestion,
  hideQuestion,
  now as domainNow,
  requireRoom,
  triggerDetection,
} from '../domain/index.js'
import type { DemoContext, DemoFan } from './index.js'
import {
  AUTOPLAY_BUDGET_MS,
  AUTOPLAY_START_MAX_MS,
  BOT_ORDER,
  DEMO_SCRIPT,
  TABS_READY_TIMEOUT_MS,
  type BotRole,
  type CardRef,
  type ScriptStep,
} from './script.js'

type FanRow = NonNullable<Awaited<ReturnType<typeof findFan>>>

export interface DirectorClock {
  /** Wall clock in ms; the default is the domain clock, so the room clock math matches the server's. */
  now(): number
  sleep(ms: number): Promise<void>
}

export const realDirectorClock: DirectorClock = {
  now: () => domainNow(),
  sleep: (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms))),
}

export interface DirectorOptions {
  clock?: DirectorClock
  script?: readonly ScriptStep[]
  log?: (msg: string) => void
  /** Runs before each step (tests use it to type creator segments in the middle of the autoplay). */
  beforeStep?: (step: ScriptStep, at: { roomId: string; roomClockMs: number }) => void | Promise<void>
}

export interface DirectorStepResult {
  id: string
  kind: ScriptStep['kind']
  /** Scripted offset (for 'say': the segment start). */
  plannedMs: number
  /** Room clock when the step ran (for 'say': when the final segment was posted). */
  atMs: number
  ok: boolean
  note: string | null
  /** For 'say': the expected card's state when the director moved on. */
  state?: QuestionState | null
  segmentSeq?: number
  /**
   * For 'say': room clock when the director first saw the card in an expected state (null: it never got there).
   * Seen by polling (detectionIdle, then a read every 250 ms), so it is an upper bound on the real moment.
   */
  reachedAtMs?: number | null
  /** For 'say': reachedAtMs - atMs, from the replay segment's post to the card's expected state (replay, not speech). */
  replayToStateMs?: number | null
}

export interface DirectorCard {
  id: string
  number: number
  state: QuestionState
  quote: string | null
}

export interface DirectorReport {
  roomId: string
  mode: AiMode
  firstStepAtMs: number | null
  finishedAtMs: number
  /** How far the timeline shifted later than scripted. */
  driftMs: number
  steps: DirectorStepResult[]
  cards: Record<CardRef, DirectorCard | null>
  /** The states each card went through while the director watched (deduplicated, in order). */
  trail: Record<CardRef, QuestionState[]>
  heldTabs: number
  declinedTabs: number
  aborted: string | null
  notes: string[]
}

const POLL_MS = 250
const IDLE_CAP_MS = 2_000
const MIN_WAIT_MS = 1_500
/** The room ended or vanished: the rest of the script cannot run. */
const STOP_CODES = new Set(['room_closed', 'not_live', 'room_not_found'])
/** Cards the detector can still change (a nudge makes sense only for these). */
const CANDIDATES: QuestionState[] = ['open', 'deflected', 'review']

const realDelay = (ms: number) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms)
    t.unref?.()
  })

function defaultLog(msg: string): void {
  if (process.env.VITEST !== 'true') console.warn(`[demo] ${msg}`)
}

const errText = (e: unknown) => (e instanceof DomainError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e))

export async function runDirector(ctx: DemoContext, opts: DirectorOptions = {}): Promise<DirectorReport> {
  const clock = opts.clock ?? realDirectorClock
  const script = opts.script ?? DEMO_SCRIPT
  const roomId = ctx.roomId
  const notes: string[] = []
  const note = (m: string) => {
    notes.push(m)
    ;(opts.log ?? defaultLog)(`room ${roomId}: ${m}`)
  }

  const room0 = await requireRoom(roomId)
  const startedAt = room0.clock_started_at ? new Date(room0.clock_started_at).getTime() : clock.now()
  const roomNow = () => Math.max(0, clock.now() - startedAt)
  let drift = 0
  let lastActionAt = 0
  let firstStepAt: number | null = null
  let aborted: string | null = null
  let manualNoted = false
  const steps: DirectorStepResult[] = []
  const cards: Record<CardRef, { id: string; number: number } | null> = { q1: null, q2: null }
  const trail: Record<CardRef, QuestionState[]> = { q1: [], q2: [] }

  const sleepUntil = async (roomMs: number) => {
    const cur = roomNow()
    if (cur < roomMs) await clock.sleep(roomMs - cur)
  }
  /** Sleep until the scripted offset (shifted by the drift so far); when late, the rest of the script shifts. */
  const at = async (plannedMs: number) => {
    const target = plannedMs + drift
    const cur = roomNow()
    if (cur < target) await clock.sleep(target - cur)
    else drift = cur - plannedMs
  }

  const mode = async (): Promise<{ mode: AiMode; reason: string | null; live: boolean }> => {
    const r = await requireRoom(roomId)
    return { mode: r.ai_mode, reason: r.ai_mode_reason, live: r.status === 'live' }
  }
  const noteManual = (reason: string | null) => {
    if (manualNoted) return
    manualNoted = true
    note(
      `AI is in manual-confirm mode (${reason ?? 'no reason given'}): the replay still plays, and the cards stay open for the creator ` +
        'to confirm by pointing at the answer span in the transcript (the same guard runs).',
    )
  }

  const track = (ref: CardRef, s: QuestionState) => {
    const t = trail[ref]
    if (t[t.length - 1] !== s) t.push(s)
  }

  /** Waits until the card is in one of `states`; nudges the detector once if it stays a candidate. */
  const waitFor = async (
    ref: CardRef,
    states: QuestionState[],
    timeoutMs: number,
  ): Promise<{ state: QuestionState | null; note: string | null; reachedAtMs: number | null }> => {
    const card = cards[ref]
    if (!card) return { state: null, note: `no ${ref.toUpperCase()} card to watch`, reachedAtMs: null }
    // Waits are clipped to the 45 s autoplay budget, but always give the detector a moment.
    const budgetEnd = startedAt + AUTOPLAY_BUDGET_MS - 500
    const deadline = Math.max(clock.now() + MIN_WAIT_MS, Math.min(clock.now() + timeoutMs, budgetEnd))
    let nudged = false
    for (;;) {
      await Promise.race([detectionIdle(roomId), realDelay(IDLE_CAP_MS)])
      const q = await getQuestion(card.id)
      track(ref, q.state)
      if (states.includes(q.state)) return { state: q.state, note: nudged ? 'reached after one extra detector run' : null, reachedAtMs: roomNow() }
      const m = await mode()
      if (!m.live) return { state: q.state, note: 'the room is no longer live', reachedAtMs: null }
      if (m.mode !== 'ai') {
        noteManual(m.reason)
        return { state: q.state, note: 'manual mode: left for the creator to confirm', reachedAtMs: null }
      }
      if (clock.now() >= deadline) return { state: q.state, note: `still ${q.state} after the safety timeout`, reachedAtMs: null }
      if (!nudged && CANDIDATES.includes(q.state)) {
        // The cue-triggered run already happened (or the prefilter missed): one more look at the newest window.
        nudged = true
        triggerDetection(roomId)
        continue
      }
      await clock.sleep(POLL_MS)
    }
  }

  // Bot holds: startDemoRoom opened them in parallel; their IDs reach the console as PayPal answers.
  let tabsSettled = false
  void ctx.tabsReady.then(() => {
    tabsSettled = true
  })
  const tabsDeadline = clock.now() + TABS_READY_TIMEOUT_MS
  while (!tabsSettled && clock.now() < tabsDeadline) {
    await Promise.race([ctx.tabsReady, realDelay(POLL_MS)])
    if (!tabsSettled) await clock.sleep(POLL_MS)
  }
  if (!tabsSettled) note(`bot holds still pending after ${TABS_READY_TIMEOUT_MS / 1000} s; starting with the holds that are placed`)

  const fans = new Map<BotRole, FanRow>()
  let heldTabs = 0
  for (const [i, role] of BOT_ORDER.entries()) {
    const f: DemoFan | undefined = ctx.stripFans[i]
    const row = f ? await findFan(roomId, f.fanToken) : null
    if (!row) continue
    fans.set(role, row)
    const me = await getMe(roomId, row).catch(() => null)
    if (me?.tab?.state === 'held') heldTabs++
  }
  const declinedRow = await findFan(roomId, ctx.declinedFan.fanToken)
  const declinedMe = declinedRow ? await getMe(roomId, declinedRow).catch(() => null) : null
  const declinedTabs = declinedMe?.tab?.state === 'declined' ? 1 : 0
  if (declinedTabs === 0) note(`the extra bot's hold is ${declinedMe?.tab?.state ?? 'missing'}, not declined`)

  const m0 = await mode()
  if (m0.mode !== 'ai') noteManual(m0.reason)

  for (const step of script) {
    const plannedMs = step.kind === 'say' ? step.tStartMs : step.atMs
    try {
      await opts.beforeStep?.(step, { roomId, roomClockMs: roomNow() })
      if (step.kind === 'say') {
        const dur = step.tEndMs - step.tStartMs
        await at(step.tStartMs)
        let start = step.tStartMs + drift
        // Every bot action must be on the clock before the answer starts, or its backer would count as late.
        if (start < lastActionAt) {
          drift += lastActionAt - start
          start = lastActionAt
        }
        firstStepAt ??= roomNow()
        const words = step.text.split(/\s+/)
        for (const f of step.interims) {
          await sleepUntil(start + Math.round(dur * f))
          const n = Math.max(1, Math.floor(words.length * f))
          await addSegment(roomId, { text: words.slice(0, n).join(' '), final: false, source: 'replay' })
        }
        await sleepUntil(start + dur)
        const { segment } = await addSegment(roomId, { text: step.text, final: true, source: 'replay', scripted: { tStartMs: start, tEndMs: start + dur } })
        const postedAt = roomNow()
        const waited = await waitFor(step.expect.ref, step.expect.states, step.expect.timeoutMs)
        steps.push({
          id: step.id,
          kind: step.kind,
          plannedMs,
          atMs: postedAt,
          ok: waited.state !== null && step.expect.states.includes(waited.state),
          note: waited.note,
          state: waited.state,
          ...(segment ? { segmentSeq: segment.seq } : {}),
          reachedAtMs: waited.reachedAtMs,
          replayToStateMs: waited.reachedAtMs === null ? null : Math.max(0, waited.reachedAtMs - postedAt),
        })
        continue
      }

      await at(step.atMs)
      firstStepAt ??= roomNow()
      const atMs = roomNow()
      const fan = fans.get(step.by)
      if (!fan) {
        steps.push({ id: step.id, kind: step.kind, plannedMs, atMs, ok: false, note: `no fan for ${step.by}` })
        continue
      }
      let stepNote: string | null = null
      if (step.kind === 'ask') {
        const q = await askQuestion(roomId, fan, { text: step.text })
        cards[step.ref] = { id: q.id, number: q.number }
        track(step.ref, q.state)
      } else if (step.kind === 'askSimilar') {
        try {
          const q = await askQuestion(roomId, fan, { text: step.text, checkSimilar: true })
          // Intake did not see the duplicate: hide the card so nothing stays reserved for it.
          await hideQuestion(q.id)
          stepNote = `intake did not flag the near-duplicate (#${q.number}); hid it, which released its reservation`
          note(stepNote)
        } catch (e) {
          if (!(e instanceof DomainError) || e.code !== 'similar_question') throw e
          const target = cards[step.similarTo]
          stepNote = `similar to #${String(e.extra.similarTo)}${target && e.extra.similarTo !== target.number ? ` (expected #${target.number})` : ''}; nothing reserved`
        }
      } else {
        const card = cards[step.ref]
        if (!card) {
          steps.push({ id: step.id, kind: step.kind, plannedMs, atMs, ok: false, note: `no ${step.ref.toUpperCase()} card to back` })
          continue
        }
        try {
          await backQuestion(card.id, fan)
        } catch (e) {
          if (!(e instanceof DomainError) || (e.code !== 'already_backed' && e.code !== 'backing_closed')) throw e
          stepNote = e.code === 'already_backed' ? 'already backed' : 'the card was already answered (creator typed it?)'
        }
      }
      lastActionAt = roomNow()
      steps.push({ id: step.id, kind: step.kind, plannedMs, atMs, ok: true, note: stepNote })
    } catch (e) {
      const code = e instanceof DomainError ? e.code : null
      steps.push({ id: step.id, kind: step.kind, plannedMs, atMs: roomNow(), ok: false, note: errText(e).slice(0, 200) })
      if (code && STOP_CODES.has(code)) {
        aborted = code
        note(`stopped at step ${step.id}: ${errText(e)}`)
        break
      }
      note(`step ${step.id} failed: ${errText(e).slice(0, 200)}`)
    }
  }

  await Promise.race([detectionIdle(roomId), realDelay(IDLE_CAP_MS)])
  const finalCards: Record<CardRef, DirectorCard | null> = { q1: null, q2: null }
  for (const ref of ['q1', 'q2'] as const) {
    const c = cards[ref]
    if (!c) continue
    const q = await getQuestion(c.id).catch(() => null)
    if (!q) continue
    track(ref, q.state)
    finalCards[ref] = { id: q.id, number: q.number, state: q.state, quote: q.quote }
  }
  const m1 = await mode().catch(() => ({ mode: m0.mode, reason: null, live: false }))
  if (m1.mode !== 'ai') {
    noteManual(m1.reason)
    const open = (['q1', 'q2'] as const).filter((r) => finalCards[r] && CANDIDATES.includes(finalCards[r]!.state)).map((r) => `#${finalCards[r]!.number}`)
    if (open.length > 0) note(`replay done in manual mode; cards ${open.join(' and ')} wait for the creator to point at their answers`)
  }
  const finishedAtMs = roomNow()
  if (firstStepAt !== null && firstStepAt > AUTOPLAY_START_MAX_MS) note(`autoplay started late, at ${(firstStepAt / 1000).toFixed(1)} s`)
  if (finishedAtMs > AUTOPLAY_BUDGET_MS) note(`autoplay ran long: ${(finishedAtMs / 1000).toFixed(1)} s`)
  ;(opts.log ?? defaultLog)(
    `room ${roomId}: replay ${aborted ? 'stopped' : 'finished'} at ${(finishedAtMs / 1000).toFixed(1)} s ` +
      `(Q1 ${finalCards.q1?.state ?? '-'}, Q2 ${finalCards.q2?.state ?? '-'}, drift ${(drift / 1000).toFixed(1)} s, ${m1.mode} mode)`,
  )
  return {
    roomId,
    mode: m1.mode,
    firstStepAtMs: firstStepAt,
    finishedAtMs,
    driftMs: drift,
    steps,
    cards: finalCards,
    trail,
    heldTabs,
    declinedTabs,
    aborted,
    notes,
  }
}

/** The default director registered by demo/index.ts. */
export const replayDirector = (ctx: DemoContext): Promise<DirectorReport> => runDirector(ctx)
