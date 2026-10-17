// Eval runner for the answer detector + deterministic guard.
//   npx tsx --env-file=.env scripts/eval.ts --split dev [--runs 1] [--limit K] [--concurrency 4]
//     [--tau 0.85] [--thinking disabled|adaptive] [--effort low|medium|high] [--max-cost-usd 0.5]
//     [--category name] [--label text] [--from-raw eval/runs/<ts>.raw.jsonl]
// The test split is held out: it refuses to run without --allow-test (see docs/eval-plan.md).
// Soak: `--split all --category demo_lines --allow-test --runs 30 --tau 0.80` runs one category across every split
// (it includes test cases, so it needs --allow-test; never tune on it). `runsAllCorrect` counts the runs in which
// every answered pair locked, every deflection showed as deflected and every partial went to review.
// Writes eval/runs/<ts>.json (summary, commit-friendly) and eval/runs/<ts>.raw.jsonl (verdicts, gitignored).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chargeForBacking } from '../src/shared/money.js'
import type { Verdict } from '../src/shared/types.js'
import { detectAnswersDetailed, type DetectDetail } from '../src/server/ai/detector.js'
import { guardVerdict } from '../src/server/ai/guard.js'
import { DEFAULT_DETECTOR_SETTINGS, type DetectorSettings } from '../src/server/ai/prompts/detector.js'
import { normPhrase } from '../src/server/ai/text.js'
import type { EvalCase, Split } from '../eval/types.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const flag = (name: string) => process.argv.includes(`--${name}`)

interface RawRecord {
  run: number
  caseId: string
  ok: boolean
  reason?: string
  latencyMs: number
  costMicros: number
  usage?: DetectDetail['usage']
  requestId?: string | null
  verdicts: Verdict[]
}

export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1]
  const p = k / n
  const d = 1 + (z * z) / n
  const c = p + (z * z) / (2 * n)
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)]
}

function pct(xs: number[], q: number): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!
}

const r3 = (x: number) => Math.round(x * 1000) / 1000

interface RunScore {
  run: number
  pairs: number
  negatives: number
  falseCharges: number
  falseChargeRate: number
  falseChargeCI: [number, number]
  answered: number
  locksCorrect: number
  recall: number
  recallLockOrReview: number
  reviewOnAnswered: number
  reviewRateAnswered: number
  reviewShareAll: number
  evidenceMissOnLock: number
  evidenceMissCases: string[]
  partials: number
  partialToReview: number
  deflections: number
  deflectionsDetected: number
  /** Every pair of that kind in this run came out right (vacuously true when the run has none). */
  allAnsweredLocked: boolean
  allDeflectionsShown: boolean
  allPartialsToReview: boolean
  lateBackerChecks: number
  lateBackerWrongCharges: number
  rawVerdictAccuracy: number
  callsFailed: number
  failReasons: Record<string, number>
  falseChargeCases: string[]
  missedAnswerCases: string[]
}

function scoreRun(run: number, records: RawRecord[], cases: Map<string, EvalCase>, tau: number): RunScore {
  const s: RunScore = {
    run, pairs: 0, negatives: 0, falseCharges: 0, falseChargeRate: 0, falseChargeCI: [0, 1], answered: 0, locksCorrect: 0,
    recall: 0, recallLockOrReview: 0, reviewOnAnswered: 0, reviewRateAnswered: 0, reviewShareAll: 0, evidenceMissOnLock: 0, evidenceMissCases: [],
    partials: 0, partialToReview: 0, deflections: 0, deflectionsDetected: 0, allAnsweredLocked: true, allDeflectionsShown: true, allPartialsToReview: true,
    lateBackerChecks: 0, lateBackerWrongCharges: 0,
    rawVerdictAccuracy: 0, callsFailed: 0, failReasons: {}, falseChargeCases: [], missedAnswerCases: [],
  }
  let lockOrReview = 0
  let reviewsAll = 0
  let rawCorrect = 0
  const norm = (v: string) => (v === 'already_covered' ? 'not_yet' : v)
  for (const rec of records) {
    const c = cases.get(rec.caseId)
    if (!c) continue
    if (!rec.ok) {
      s.callsFailed++
      s.failReasons[rec.reason ?? 'unknown'] = (s.failReasons[rec.reason ?? 'unknown'] ?? 0) + 1
    }
    for (const e of c.expected) {
      const q = c.questions.find((x) => x.number === e.questionNumber)!
      const v: Verdict = rec.verdicts.find((x) => x.questionNumber === e.questionNumber) ?? {
        questionNumber: e.questionNumber,
        verdict: 'not_yet',
        evidence: null,
        confidence: 0,
      }
      const g = guardVerdict(v, q, c.window, { tau })
      s.pairs++
      if (norm(v.verdict) === norm(e.verdict)) rawCorrect++
      if (g.action === 'review') reviewsAll++
      if (e.verdict !== 'answered') {
        s.negatives++
        if (g.action === 'lock') {
          s.falseCharges++
          s.falseChargeCases.push(`${c.id}#Q${e.questionNumber}`)
        }
      } else {
        s.answered++
        if (g.action === 'lock') {
          s.locksCorrect++
          const quote = ` ${normPhrase(g.quote ?? '')} `
          const ok = (e.evidenceWords ?? []).every((w) => quote.includes(normPhrase(w)))
          if (!ok) {
            s.evidenceMissOnLock++
            s.evidenceMissCases.push(`${c.id}#Q${e.questionNumber}`)
          }
        } else s.missedAnswerCases.push(`${c.id}#Q${e.questionNumber}:${g.action}`)
        if (g.action === 'lock' || g.action === 'review') lockOrReview++
        if (g.action === 'review') s.reviewOnAnswered++
      }
      if (e.verdict === 'partial') {
        s.partials++
        if (g.action === 'review') s.partialToReview++
      }
      if (e.verdict === 'deflected') {
        s.deflections++
        if (g.action === 'deflected') s.deflectionsDetected++
      }
      for (const b of e.backers ?? []) {
        s.lateBackerChecks++
        const charge =
          g.action === 'lock'
            ? chargeForBacking({ amountCents: 300, rating: 'full', backedAtMs: b.backedAtMs, answerStartMs: g.answerStartMs ?? null })
            : 0
        if (charge > 0 && !b.expectCharged) s.lateBackerWrongCharges++
      }
    }
  }
  s.falseChargeRate = s.negatives ? s.falseCharges / s.negatives : 0
  s.falseChargeCI = wilson(s.falseCharges, s.negatives)
  s.recall = s.answered ? s.locksCorrect / s.answered : 0
  s.recallLockOrReview = s.answered ? lockOrReview / s.answered : 0
  s.reviewRateAnswered = s.answered ? s.reviewOnAnswered / s.answered : 0
  s.reviewShareAll = s.pairs ? reviewsAll / s.pairs : 0
  s.rawVerdictAccuracy = s.pairs ? rawCorrect / s.pairs : 0
  s.allAnsweredLocked = s.locksCorrect === s.answered
  s.allDeflectionsShown = s.deflectionsDetected === s.deflections
  s.allPartialsToReview = s.partialToReview === s.partials
  return s
}

function summarize(records: RawRecord[], cases: Map<string, EvalCase>, tau: number) {
  const runs = [...new Set(records.map((r) => r.run))].sort((a, b) => a - b)
  const perRun = runs.map((run) => scoreRun(run, records.filter((r) => r.run === run), cases, tau))
  const worst = perRun.reduce((a, b) => (b.falseChargeRate > a.falseChargeRate ? b : a), perRun[0]!)
  const mean = (f: (s: RunScore) => number) => perRun.reduce((a, s) => a + f(s), 0) / Math.max(1, perRun.length)
  const pooledK = perRun.reduce((a, s) => a + s.falseCharges, 0)
  const pooledN = perRun.reduce((a, s) => a + s.negatives, 0)
  return {
    tau,
    runs: perRun.length,
    worstRunFalseChargeRate: r3(worst.falseChargeRate),
    worstRunFalseCharges: `${worst.falseCharges}/${worst.negatives}`,
    worstRunFalseChargeWilson95: worst.falseChargeCI.map(r3),
    meanFalseChargeRate: r3(mean((s) => s.falseChargeRate)),
    pooledFalseChargeWilson95: wilson(pooledK, pooledN).map(r3),
    meanRecall: r3(mean((s) => s.recall)),
    minRecall: r3(Math.min(...perRun.map((s) => s.recall))),
    recallWilson95FirstRun: wilson(perRun[0]!.locksCorrect, perRun[0]!.answered).map(r3),
    meanRecallLockOrReview: r3(mean((s) => s.recallLockOrReview)),
    meanReviewRateOnAnswered: r3(mean((s) => s.reviewRateAnswered)),
    meanReviewShareAllPairs: r3(mean((s) => s.reviewShareAll)),
    meanRawVerdictAccuracy: r3(mean((s) => s.rawVerdictAccuracy)),
    runsAllCorrect: {
      runs: perRun.length,
      answeredLocked: perRun.filter((s) => s.allAnsweredLocked).length,
      deflectionsShown: perRun.filter((s) => s.allDeflectionsShown).length,
      partialsToReview: perRun.filter((s) => s.allPartialsToReview).length,
    },
    pairTotals: {
      answered: `${perRun.reduce((a, s) => a + s.locksCorrect, 0)}/${perRun.reduce((a, s) => a + s.answered, 0)} locked`,
      deflections: `${perRun.reduce((a, s) => a + s.deflectionsDetected, 0)}/${perRun.reduce((a, s) => a + s.deflections, 0)} deflected`,
      partials: `${perRun.reduce((a, s) => a + s.partialToReview, 0)}/${perRun.reduce((a, s) => a + s.partials, 0)} to review`,
    },
    perRun: perRun.map((s) => ({
      ...s,
      falseChargeRate: r3(s.falseChargeRate),
      falseChargeCI: s.falseChargeCI.map(r3),
      recall: r3(s.recall),
      recallLockOrReview: r3(s.recallLockOrReview),
      reviewRateAnswered: r3(s.reviewRateAnswered),
      reviewShareAll: r3(s.reviewShareAll),
      rawVerdictAccuracy: r3(s.rawVerdictAccuracy),
    })),
  }
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i]!)
      }
    }),
  )
  return out
}

async function main(): Promise<void> {
  const split = (arg('split') ?? 'dev') as Split | 'all'
  if (!['dev', 'val', 'test', 'all'].includes(split)) throw new Error(`bad --split ${split}`)
  if (split === 'all' && !arg('category')) throw new Error('--split all runs one category across the splits: pass --category.')
  if ((split === 'test' || split === 'all') && !flag('allow-test')) {
    throw new Error('The test split is held out. Pre-register targets in docs/eval-plan.md, then pass --allow-test.')
  }
  const runs = Number(arg('runs') ?? 1)
  const limit = arg('limit') ? Number(arg('limit')) : Infinity
  const concurrency = Number(arg('concurrency') ?? 4)
  const tau = Number(arg('tau') ?? 0.85)
  const maxCostMicros = Math.round(Number(arg('max-cost-usd') ?? 0.5) * 1_000_000)
  const settings: DetectorSettings = {
    ...DEFAULT_DETECTOR_SETTINGS,
    ...(arg('thinking') ? { thinking: arg('thinking') as DetectorSettings['thinking'] } : {}),
    ...(arg('effort') ? { effort: arg('effort') as DetectorSettings['effort'] } : {}),
  }
  const all: EvalCase[] = readFileSync(path.join(root, 'eval/data/cases.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as EvalCase)
  const category = arg('category')
  const selected = all.filter((c) => (split === 'all' || c.split === split) && (!category || c.category === category)).slice(0, limit)
  if (selected.length === 0) throw new Error(`no cases for --split ${split}${category ? ` --category ${category}` : ''}`)
  const byId = new Map(selected.map((c) => [c.id, c]))

  let records: RawRecord[] = []
  const fromRaw = arg('from-raw')
  if (fromRaw) {
    records = readFileSync(path.resolve(root, fromRaw), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as RawRecord)
      .filter((r) => byId.has(r.caseId))
  } else {
    let spent = 0
    let stopped = false
    for (let run = 1; run <= runs && !stopped; run++) {
      const one = async (c: EvalCase): Promise<RawRecord | null> => {
        if (spent >= maxCostMicros) {
          stopped = true
          return null
        }
        const d = await detectAnswersDetailed({ roomId: null, openQuestions: c.questions, window: c.window }, { offline: true, settings })
        spent += d.costMicros
        return { run, caseId: c.id, ok: d.ok, reason: d.reason, latencyMs: d.latencyMs, costMicros: d.costMicros, usage: d.usage, requestId: d.requestId, verdicts: d.verdicts }
      }
      // First call alone so the rubric cache is written before the parallel calls read it.
      const first = selected[0] ? await one(selected[0]) : null
      const rest = await pool(selected.slice(1), concurrency, one)
      for (const r of [first, ...rest]) if (r) records.push(r)
      process.stderr.write(`run ${run}: ${records.filter((r) => r.run === run).length} calls, spent so far $${(spent / 1e6).toFixed(4)}\n`)
    }
    if (stopped) process.stderr.write(`stopped early at the --max-cost-usd cap\n`)
  }

  const ok = records.filter((r) => r.ok && r.reason !== 'empty')
  const latencies = ok.map((r) => r.latencyMs)
  const costs = records.map((r) => r.costMicros)
  const main = summarize(records, byId, tau)
  const sweep = [0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95].map((t) => {
    const s = summarize(records, byId, t)
    return {
      tau: t,
      worstRunFalseChargeRate: s.worstRunFalseChargeRate,
      worstRunFalseCharges: s.worstRunFalseCharges,
      worstRunFalseChargeWilson95: s.worstRunFalseChargeWilson95,
      meanRecall: s.meanRecall,
      minRecall: s.minRecall,
      meanReviewRateOnAnswered: s.meanReviewRateOnAnswered,
    }
  })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const summary = {
    createdAt: new Date().toISOString(),
    label: arg('label') ?? null,
    split,
    category: category ?? null,
    cases: selected.length,
    syntheticCases: selected.filter((c) => c.synthetic).length,
    model: 'claude-haiku-5-5',
    settings,
    fromRaw: fromRaw ?? null,
    calls: records.length,
    failedCalls: records.filter((r) => !r.ok).length,
    latencyMs: { p50: pct(latencies, 0.5), p95: pct(latencies, 0.95), max: Math.max(0, ...latencies) },
    costPerCaseMicros: Math.round(costs.reduce((a, b) => a + b, 0) / Math.max(1, costs.length)),
    totalCostMicros: costs.reduce((a, b) => a + b, 0),
    cacheReadShare: r3(
      ok.reduce((a, r) => a + (r.usage?.cacheRead ?? 0), 0) /
        Math.max(1, ok.reduce((a, r) => a + (r.usage ? r.usage.input + r.usage.cacheRead + r.usage.cacheWrite : 0), 0)),
    ),
    metrics: main,
    tauSweep: sweep,
  }
  const dir = path.join(root, 'eval/runs')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `${ts}.json`), JSON.stringify(summary, null, 2) + '\n')
  if (!fromRaw) writeFileSync(path.join(dir, `${ts}.raw.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n')

  const m = main
  console.log(`split=${split} cases=${selected.length} runs=${m.runs} tau=${tau} settings=${JSON.stringify(settings)}`)
  console.log(`false-charge worst run ${m.worstRunFalseCharges} = ${m.worstRunFalseChargeRate} (Wilson95 ${m.worstRunFalseChargeWilson95.join('-')}), mean ${m.meanFalseChargeRate}`)
  console.log(`recall mean ${m.meanRecall} (min ${m.minRecall}), lock-or-review ${m.meanRecallLockOrReview}, review on answered ${m.meanReviewRateOnAnswered}, raw verdict acc ${m.meanRawVerdictAccuracy}`)
  const rc = m.runsAllCorrect
  console.log(`runs all correct: answered locked ${rc.answeredLocked}/${rc.runs}, deflections shown ${rc.deflectionsShown}/${rc.runs}, partials to review ${rc.partialsToReview}/${rc.runs}; pairs: ${Object.values(m.pairTotals).join(', ')}`)
  console.log(`latency p50 ${summary.latencyMs.p50} ms p95 ${summary.latencyMs.p95} ms; cost/case ${summary.costPerCaseMicros} micros; total $${(summary.totalCostMicros / 1e6).toFixed(4)}; failed calls ${summary.failedCalls}`)
  for (const r of m.perRun) {
    if (r.falseChargeCases.length) console.log(`  run ${r.run} false charges: ${r.falseChargeCases.join(', ')}`)
    if (r.missedAnswerCases.length) console.log(`  run ${r.run} answered but not locked: ${r.missedAnswerCases.join(', ')}`)
    if (r.evidenceMissOnLock) console.log(`  run ${r.run} locks with evidence keyword miss: ${r.evidenceMissCases.join(', ')}`)
    if (r.lateBackerWrongCharges) console.log(`  run ${r.run} late backers charged: ${r.lateBackerWrongCharges}`)
  }
  console.log('tau sweep:')
  for (const s of sweep) console.log(`  tau ${s.tau}: worst FC ${s.worstRunFalseCharges} recall ${s.meanRecall} (min ${s.minRecall}) review ${s.meanReviewRateOnAnswered}`)
  console.log(`summary: eval/runs/${ts}.json`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
