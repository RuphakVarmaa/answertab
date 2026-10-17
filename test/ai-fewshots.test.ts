// Eval data hygiene: few-shots come only from dev and never leak into val/test; cases are well formed.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FEW_SHOTS } from '../src/server/ai/prompts/fewShots.js'
import { DETECTOR_SYSTEM } from '../src/server/ai/prompts/detector.js'
import { guardVerdict } from '../src/server/ai/guard.js'
import { normPhrase, wordsOf } from '../src/server/ai/text.js'
import type { EvalCase } from '../eval/types.js'

const cases: EvalCase[] = readFileSync(new URL('../eval/data/cases.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l))

describe('eval cases', () => {
  it('has at least 120 synthetic, well-formed cases in dev/val/test', () => {
    expect(cases.length).toBeGreaterThanOrEqual(120)
    for (const c of cases) {
      expect(c.synthetic).toBe(true)
      expect(['dev', 'val', 'test']).toContain(c.split)
      expect(c.expected.map((e) => e.questionNumber).sort()).toEqual(c.questions.map((q) => q.number).sort())
      for (const s of c.window) expect(s.words).toEqual(wordsOf(s.text))
      for (const e of c.expected) expect(['answered', 'partial', 'deflected', 'already_covered', 'not_yet']).toContain(e.verdict)
    }
    const cats = new Set(cases.map((c) => c.category))
    for (const want of ['direct', 'paraphrased', 'out_of_order', 'mid_tangent', 'partial', 'deflection', 'mentioned_not_answered', 'sarcasm', 'answered_before_asked', 'read_aloud', 'late_backer', 'asr_mangled', 'injection_creator', 'injection_fan', 'security_topic', 'demo_lines']) {
      expect(cats).toContain(want)
    }
    expect(cases.filter((c) => c.category === 'asr_mangled')).toHaveLength(10)
  })

  it('every few-shot is a dev case with identical text, and never appears in val or test', () => {
    const heldOut = cases.filter((c) => c.split !== 'dev')
    const heldOutText = new Set(heldOut.flatMap((c) => [...c.window.map((s) => normPhrase(s.text)), ...c.questions.map((q) => normPhrase(q.text))]))
    for (const f of FEW_SHOTS) {
      const c = cases.find((x) => x.id === f.caseId)
      expect(c?.split).toBe('dev')
      expect(c?.window.map((s) => s.text)).toEqual(f.segments.map((s) => s.text))
      for (const s of f.segments) expect(heldOutText.has(normPhrase(s.text))).toBe(false)
      for (const q of f.questions) expect(heldOutText.has(normPhrase(q.text))).toBe(false)
    }
  })

  it('few-shot outputs are valid under the guard, and appear in the cached rubric', () => {
    for (const f of FEW_SHOTS) {
      const window = f.segments.map((s) => ({ ...s, words: wordsOf(s.text), source: 'replay' as const, final: true }))
      for (const v of f.output) {
        const q = f.questions.find((x) => x.number === v.questionNumber)!
        const g = guardVerdict(v, q, window, { tau: 0.85 })
        const want = v.verdict === 'answered' ? 'lock' : v.verdict === 'partial' ? 'review' : v.verdict === 'deflected' ? 'deflected' : 'ignore'
        expect(g.action).toBe(want)
      }
      expect(DETECTOR_SYSTEM).toContain(f.segments[0]!.text.split(' ').slice(0, 3).map((w, i) => `[${i}]${w}`).join(' '))
    }
  })
})
