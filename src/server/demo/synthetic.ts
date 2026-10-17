// Synthetic run: the whole judge path once, with fresh IDs, against whatever PayPal and Claude this process is
// wired to (the real sandbox and the real model for `npm run synthetic` and the in-server scheduler; fakes in tests).
//   demo room (bots, one processor decline, plus a bot "Eve" whose hold is voided) -> replay director ->
//   End -> settle with Q2 rated half -> verify a receipt -> contest the Q2 share via the receipt token ->
//   wait for the desk -> close the contest window -> payout -> poll until terminal
// The result goes to synthetic_runs (ok + details: PayPal IDs, timings, costs). Never tokens or card data.
import type { QuestionState, Rating } from '../../shared/types.js'
import { config } from '../config.js'
import { db } from '../db/db.js'
import { newId } from '../ids.js'
import { botCard } from '../paypal/index.js'
import {
  DomainError,
  closeContestWindow,
  contestsIdle,
  createContest,
  decideContest,
  detectionIdle,
  endRoom,
  findFan,
  getConsoleView,
  getContest,
  getMe,
  getPayoutView,
  getReceipt,
  joinRoom,
  openBotTab,
  pointSpan,
  pollPayout,
  settleRoom,
  verifyReceipt,
} from '../domain/index.js'
import { runDirector, type DirectorClock, type DirectorReport } from './director.js'
import { DEMO_TAB_CENTS, demoDirectorDone, demoTabsReady, startDemoRoom } from './index.js'
import { AUTOPLAY_BUDGET_MS, AUTOPLAY_START_MAX_MS, Q1_QUOTE_FRAGMENT, SCRIPT_TEXT } from './script.js'

export interface SyntheticOptions {
  log?: (msg: string) => void
  /** Tests: the director's clock (sleeps advance pinned time). */
  directorClock?: DirectorClock
  /** Waits between payout polls (default real setTimeout). */
  sleep?: (ms: number) => Promise<void>
  pollEveryMs?: number
  payoutTimeoutMs?: number
  deskTimeoutMs?: number
  ip?: string
}

export interface SyntheticCheck {
  name: string
  ok: boolean
  detail: string
}

export interface SyntheticDetails {
  version: 1
  mode: 'ai' | 'manual' | null
  pool: string | null
  checks: SyntheticCheck[]
  /** Milliseconds from the start of the run. */
  timings: Record<string, number>
  director: Pick<DirectorReport, 'firstStepAtMs' | 'finishedAtMs' | 'driftMs' | 'notes' | 'aborted'> & {
    /** 'say' steps add state, reachedAtMs and replayToStateMs (room clock; replay segments, not speech). */
    steps: { id: string; ok: boolean; atMs: number; note: string | null; state?: QuestionState | null; reachedAtMs?: number | null; replayToStateMs?: number | null }[]
    trail: DirectorReport['trail']
    /** The Q1 answer's replay-to-lock on the room clock (null unless it locked); runbook soak table. */
    replayToLockMs?: number | null
  } | null
  cards: { q1: { number: number; state: QuestionState; creatorPointed: boolean } | null; q2: { number: number; state: QuestionState; creatorPointed: boolean } | null }
  paypal: {
    tabs: { fan: string; state: string; authStatus: string | null; orderId: string | null; authorizationId: string | null; captureId: string | null; capturedCents: number; feeCents: number | null; releasedCents: number }[]
    refund: { contestId: string; state: string; finding: string | null; refundId: string | null; refundCents: number | null } | null
    payout: { payoutBatchId: string | null; state: string; batchStatus: string | null; amountCents: number; feeCents: number | null; webhookSeen: boolean } | null
    receiptVerify: { matches: boolean; mismatches: string[] } | null
    ledger: { calls: number; errors: { op: string; httpStatus: number; debugId: string | null; requestId: string | null }[] }
    feesCents: number
  }
  costs: { llmMicros: number; byPurpose: Record<string, { calls: number; micros: number }> }
  error?: string
}

export interface SyntheticResult {
  id: string
  ok: boolean
  roomId: string | null
  details: SyntheticDetails
}

const TERMINAL_PAYOUT = new Set(['success', 'denied', 'unclaimed', 'failed'])
const CONTEST_REASON = "The testing part was put off to next week, so that part wasn't answered."

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)))

function bounded<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const t = new Promise<'timeout'>((r) => {
    timer = setTimeout(() => r('timeout'), ms)
    timer.unref?.()
  })
  return Promise.race([p, t]).finally(() => clearTimeout(timer))
}

const errText = (e: unknown) => (e instanceof DomainError ? `${e.code}: ${e.message}` : e instanceof Error ? `${e.name}: ${e.message}` : String(e))

export async function runSynthetic(opts: SyntheticOptions = {}): Promise<SyntheticResult> {
  const log = opts.log ?? ((m: string) => console.warn(`[synthetic] ${m}`))
  const sleep = opts.sleep ?? realSleep
  const id = newId('syn')
  const t0 = Date.now()
  const timings: Record<string, number> = {}
  const mark = (k: string) => {
    timings[k] = Date.now() - t0
  }
  const checks: SyntheticCheck[] = []
  const check = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail })
    log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`)
  }
  const details: SyntheticDetails = {
    version: 1,
    mode: null,
    pool: null,
    checks,
    timings,
    director: null,
    cards: { q1: null, q2: null },
    paypal: { tabs: [], refund: null, payout: null, receiptVerify: null, ledger: { calls: 0, errors: [] }, feesCents: 0 },
    costs: { llmMicros: 0, byPurpose: {} },
  }
  await db().query(`INSERT INTO synthetic_runs (id, started_at, details) VALUES ($1, $2, $3::jsonb)`, [id, new Date(t0), JSON.stringify({ version: 1, phase: 'started' })])
  let roomId: string | null = null

  try {
    // 1. Demo room: the same bots and replay director as POST /api/demo, passed explicitly so DEMO_AUTOPLAY cannot skip it.
    const cfg = config()
    const director = (ctx: Parameters<typeof runDirector>[0]) => runDirector(ctx, { log, ...(opts.directorClock ? { clock: opts.directorClock } : {}) })
    const demo = await startDemoRoom({ judgeCode: cfg.judgeCode ?? undefined, ip: opts.ip ?? 'synthetic-run', director })
    roomId = demo.roomId
    mark('roomCreated')
    log(`room ${roomId}`)
    // A fifth bot that holds and never asks: its hold is voided at settlement.
    const eve = await joinRoom(roomId, 'Eve', { isBot: true })
    const eveTab = openBotTab(roomId, eve.fanId, { ceilingCents: DEMO_TAB_CENTS, card: botCard(1, 'Eve Test') }).catch((e: unknown) => e)
    await demoTabsReady(roomId)
    await eveTab
    mark('tabsReady')
    const report = (await demoDirectorDone(roomId)) as DirectorReport | null
    mark('autoplayDone')
    if (!report) throw new Error('the replay director did not report')
    details.mode = report.mode
    details.director = {
      firstStepAtMs: report.firstStepAtMs,
      finishedAtMs: report.finishedAtMs,
      driftMs: report.driftMs,
      notes: report.notes,
      aborted: report.aborted,
      steps: report.steps.map((s) => ({
        id: s.id,
        ok: s.ok,
        atMs: s.atMs,
        note: s.note,
        ...(s.kind === 'say' ? { state: s.state ?? null, reachedAtMs: s.reachedAtMs ?? null, replayToStateMs: s.replayToStateMs ?? null } : {}),
      })),
      trail: report.trail,
      replayToLockMs: replayToLock(report),
    }
    check('bot_holds', report.heldTabs === 3 && report.declinedTabs === 1, `${report.heldTabs}/3 strip holds placed, ${report.declinedTabs}/1 processor decline`)
    check(
      'autoplay_timing',
      report.firstStepAtMs !== null && report.firstStepAtMs <= AUTOPLAY_START_MAX_MS && report.finishedAtMs <= AUTOPLAY_BUDGET_MS && !report.aborted,
      `started at ${fmtS(report.firstStepAtMs)}, finished at ${fmtS(report.finishedAtMs)} (limits ${AUTOPLAY_START_MAX_MS / 1000} s / ${AUTOPLAY_BUDGET_MS / 1000} s), drift ${fmtS(report.driftMs)}`,
    )
    const q1 = report.cards.q1
    const q2 = report.cards.q2
    if (!q1 || !q2) throw new Error(`the script did not create both questions (q1 ${q1 ? 'ok' : 'missing'}, q2 ${q2 ? 'ok' : 'missing'})`)

    // 2. The detector's outcome. In manual mode (no key, budget hit) the run confirms answers like a creator would.
    const trail = report.trail.q1
    const deflectedFirst = trail.includes('deflected') && trail.indexOf('deflected') < Math.max(trail.indexOf('locked'), trail.indexOf('review'))
    if (report.mode === 'ai') {
      check(
        'detector_script',
        deflectedFirst && q1.state === 'locked' && (q1.quote ?? '').includes(Q1_QUOTE_FRAGMENT) && q2.state === 'review',
        `Q1 ${trail.join(' -> ')}${q1.quote ? ` "${q1.quote}"` : ''}; Q2 ${report.trail.q2.join(' -> ')}`,
      )
    } else {
      check('detector_script', true, `manual-confirm mode (${report.notes[0] ?? 'AI off'}); answers are creator-pointed`)
    }
    const pointed = { q1: false, q2: false }
    const segs = (await getConsoleView(roomId)).segments
    const pointAt = async (ref: 'q1' | 'q2', text: string, fromWord: number) => {
      const seg = segs.find((s) => s.source === 'replay' && s.text === text)
      if (!seg) throw new Error(`replay segment for ${ref} not found`)
      await pointSpan(report.cards[ref]!.id, { startSeg: seg.seq, startWord: fromWord, endSeg: seg.seq, endWord: seg.words.length - 1 })
      pointed[ref] = true
    }
    const pointable: QuestionState[] = ['open', 'deflected']
    if (pointable.includes(q1.state)) await pointAt('q1', SCRIPT_TEXT.answer, 2)
    if (pointable.includes(q2.state)) await pointAt('q2', SCRIPT_TEXT.partial, 0)

    // 3. End: Q1 holds $12 from 3 backers who all backed before the answer started.
    await bounded(detectionIdle(roomId), 30_000)
    const review = await endRoom(roomId)
    mark('ended')
    const r1 = review.find((r) => r.questionNumber === q1.number)
    const r2 = review.find((r) => r.questionNumber === q2.number)
    details.cards = {
      q1: r1 ? { number: q1.number, state: r1.state, creatorPointed: pointed.q1 } : null,
      q2: r2 ? { number: q2.number, state: r2.state, creatorPointed: pointed.q2 } : null,
    }
    check('review_q1', !!r1 && r1.backers === 3 && r1.lockedCents === 1200, `Q1 ${r1?.state}: ${r1?.backers} backers, ${r1?.lockedCents} cents locked`)

    // 4. Settle: approve all, Q2 rated half (a Q1 the verifier sent to review is rated full).
    const ratings: Record<string, Rating> = { [String(q2.number)]: 'half' }
    if (r1?.state === 'review') ratings[String(q1.number)] = 'full'
    let settled: Awaited<ReturnType<typeof settleRoom>> | null = null
    for (let i = 0; i < 10 && !settled; i++) {
      try {
        settled = await settleRoom(roomId, ratings)
      } catch (e) {
        if (!(e instanceof DomainError) || e.code !== 'still_verifying') throw e
        await bounded(detectionIdle(roomId), 10_000)
        await sleep(1_000)
      }
    }
    if (!settled) throw new Error('settle kept answering still_verifying')
    mark('settled')
    const byName = Object.fromEntries(settled.tabs.map((t) => [t.displayName, t]))
    const want: Record<string, [string, number]> = { Asha: ['captured', 600], Ben: ['captured', 300], Chen: ['captured', 600], Dev: ['declined', 0], Eve: ['voided', 0] }
    const bad = Object.entries(want).filter(([n, [state, cents]]) => byName[n]?.state !== state || byName[n]?.capturedCents !== cents)
    check(
      'settle',
      settled.room.status === 'settled' && bad.length === 0 && settled.errors.length === 0,
      `${settled.room.status}; ${Object.keys(want).map((n) => `${n} ${byName[n]?.state ?? '-'} ${byName[n]?.capturedCents ?? '-'}`).join(', ')}` +
        (settled.errors.length ? `; errors: ${settled.errors.map((e) => e.message).join(' | ').slice(0, 300)}` : ''),
    )

    // 5. Receipt: Chen's, verified live, then contest the half-charged Q2 line through the receipt token.
    const chen = await findFan(roomId, demo.stripFans[2]!.fanToken)
    const token = chen ? (await getMe(roomId, chen)).tab?.receiptToken : null
    if (!token) throw new Error("no receipt for Chen's tab")
    const v = await verifyReceipt(token)
    details.paypal.receiptVerify = { matches: v.matches, mismatches: v.mismatches }
    check('receipt_verify', v.matches, v.matches ? `capture ${v.capture?.id} ${v.capture?.status}` : v.mismatches.join('; '))
    const receipt = await getReceipt(token)
    const line = receipt.lines.find((l) => l.questionNumber === q2.number)
    if (!line) throw new Error('no Q2 line on the receipt')
    const contest = await createContest(token, { backingId: line.backingId, reason: CONTEST_REASON })
    const deskTimeout = opts.deskTimeoutMs ?? 180_000
    if ((await bounded(contestsIdle(), deskTimeout)) === 'timeout') log(`contest desk still working after ${deskTimeout / 1000} s`)
    let c = await getContest(contest.id)
    const deskState = c.state
    if (c.state === 'pending_creator' || c.state === 'failed') {
      // The desk wanted the creator (or could not decide): approve, as the creator would in the console.
      log(`desk answered ${c.state}; approving as the creator`)
      await decideContest(contest.id, true)
      await bounded(contestsIdle(), 60_000)
      c = await getContest(contest.id)
    }
    mark('contestDone')
    details.paypal.refund = { contestId: c.id, state: c.state, finding: c.finding, refundId: c.refundId, refundCents: c.refundCents }
    check(
      'contest_refund',
      c.state === 'refunded' && c.refundCents === 300 && !!c.refundId,
      `desk ${deskState}${deskState !== c.state ? ` -> ${c.state}` : ''}, finding ${c.finding ?? '-'}, refund ${c.refundId ?? '-'} (${c.refundCents ?? 0} cents)`,
    )

    // 6. Close the contest window (demo control) and follow the Payouts batch to a terminal status.
    const closed = await closeContestWindow(roomId, { force: true })
    mark('payoutCreated')
    if (!closed.payout) throw new Error('no payout was created')
    const pollEvery = opts.pollEveryMs ?? 10_000
    const payoutDeadline = Date.now() + (opts.payoutTimeoutMs ?? 300_000)
    let payout = await getPayoutView(roomId)
    for (let i = 1; payout && !TERMINAL_PAYOUT.has(payout.state) && Date.now() < payoutDeadline; i++) {
      await sleep(pollEvery)
      await pollPayout(roomId, i)
      payout = await getPayoutView(roomId)
    }
    mark('payoutTerminal')
    details.paypal.payout = payout
      ? { payoutBatchId: payout.payoutBatchId, state: payout.state, batchStatus: payout.batchStatus, amountCents: payout.amountCents, feeCents: payout.feeCents, webhookSeen: payout.webhookSeen }
      : null
    check('payout', payout?.state === 'success', `${payout?.payoutBatchId ?? '-'} ${payout?.batchStatus ?? '-'} (${payout?.state ?? 'none'}), ${payout?.amountCents ?? 0} cents`)
  } catch (e) {
    details.error = errText(e).slice(0, 500)
    check('run', false, details.error)
  }

  if (roomId) await collect(roomId, details).catch((e) => log(`could not collect details: ${errText(e)}`))
  mark('total')
  const ok = checks.length > 0 && checks.every((c) => c.ok) && !details.error
  await db().query(`UPDATE synthetic_runs SET finished_at = $2, ok = $3, room_id = $4, details = $5::jsonb WHERE id = $1`, [id, new Date(), ok, roomId, JSON.stringify(details)])
  log(`${ok ? 'PASSED' : 'FAILED'} ${id} (room ${roomId ?? '-'}) in ${fmtS(timings.total ?? 0)}`)
  return { id, ok, roomId, details }
}

/** PayPal IDs, ledger errors and LLM spend for the room (IDs and statuses only). */
async function collect(roomId: string, details: SyntheticDetails): Promise<void> {
  const view = await getConsoleView(roomId)
  details.pool = (await db().query<{ pool: string }>(`SELECT pool FROM rooms WHERE id = $1`, [roomId]))[0]?.pool ?? null
  details.paypal.tabs = view.tabs.map((t) => ({
    fan: t.displayName,
    state: t.state,
    authStatus: t.authStatus,
    orderId: t.orderId,
    authorizationId: t.authorizationId,
    captureId: t.captureId,
    capturedCents: t.capturedCents,
    feeCents: t.feeCents,
    releasedCents: t.releasedCents,
  }))
  details.paypal.feesCents = view.tabs.reduce((a, t) => a + (t.feeCents ?? 0), 0)
  details.paypal.ledger = {
    calls: view.ledger.length,
    errors: view.ledger.filter((c) => c.httpStatus === 0 || c.httpStatus >= 400).map((c) => ({ op: c.op, httpStatus: c.httpStatus, debugId: c.debugId, requestId: c.requestId })),
  }
  const rows = await db().query<{ purpose: string; n: number; micros: string | number }>(
    `SELECT purpose, count(*)::int AS n, COALESCE(sum(cost_micros), 0) AS micros FROM detections WHERE room_id = $1 GROUP BY purpose ORDER BY purpose`,
    [roomId],
  )
  details.costs.byPurpose = Object.fromEntries(rows.map((r) => [r.purpose, { calls: r.n, micros: Number(r.micros) }]))
  details.costs.llmMicros = Number(view.llmSpentMicros)
}

/** From the Q1 answer segment's post to the card reading 'locked' (the verifier included), or null. */
export function replayToLock(report: Pick<DirectorReport, 'steps'>): number | null {
  const s = report.steps.find((x) => x.id === 'answer-q1')
  return s && s.state === 'locked' && typeof s.replayToStateMs === 'number' ? s.replayToStateMs : null
}

function fmtS(ms: number | null): string {
  return ms === null ? '-' : `${(ms / 1000).toFixed(1)} s`
}

/**
 * Optional in-server schedule: one synthetic run every SYNTHETIC_EVERY_MIN minutes (default off, minimum 5).
 * The API boot calls this once; the returned function stops it. Runs never overlap.
 */
export function startSyntheticScheduler(p: { everyMin?: number; firstDelayMs?: number; log?: (msg: string) => void } = {}): () => void {
  const raw = p.everyMin ?? Number(process.env.SYNTHETIC_EVERY_MIN ?? '')
  if (!Number.isFinite(raw) || raw <= 0) return () => {}
  const everyMs = Math.max(5, raw) * 60_000
  const log = p.log ?? ((m: string) => console.warn(`[synthetic] ${m}`))
  let running = false
  let stopped = false
  const tick = async () => {
    if (running || stopped) return
    running = true
    try {
      const r = await runSynthetic({ log })
      log(`scheduled run ${r.id}: ${r.ok ? 'passed' : 'failed'}`)
    } catch (e) {
      log(`scheduled run crashed: ${errText(e)}`)
    } finally {
      running = false
    }
  }
  const first = setTimeout(() => void tick(), p.firstDelayMs ?? 60_000)
  const timer = setInterval(() => void tick(), everyMs)
  first.unref?.()
  timer.unref?.()
  log(`scheduled every ${everyMs / 60_000} min`)
  return () => {
    stopped = true
    clearTimeout(first)
    clearInterval(timer)
  }
}
