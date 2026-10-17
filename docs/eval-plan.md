# Detector eval plan (pre-registered)

Written on 2026-10-16, before any detector run on the validation or test splits. The targets and the τ rule below are fixed now; later results are compared against them as written, and changes to this file after a val/test run must be dated and explained at the bottom.

## What is measured

The live answer detector (`claude-haiku-5-5`, `src/server/ai/detector.ts`) followed by the deterministic guard (`src/server/ai/guard.ts`), exactly as the server runs them. The Opus verifier and the creator's approval are *not* in the loop, so every number here is a worst case for false charges: in the product a lock still needs the creator to approve it at End stream, and big locks also need the Opus re-check.

Runner: `scripts/eval.ts`. Data: `eval/data/cases.jsonl`, built by `eval/build-cases.ts`.

## Data (honest status)

- 130 cases, **all synthetic**: hand-written transcript windows in the style of coding office hours, with segment timings derived from word counts. `synthetic: true` on every row.
- None come from real audio yet. The brief asks for at least 40 real-audio cases (the builder's mock office hours and the pilot, run through the same Chrome speech path); those are added later and reported separately.
- Splits: dev 43 (prompt work and few-shot source), val 40 (τ tuning), test 47 (held out, reported once).
- Categories (dev/val/test): direct 4/4/4, paraphrased 4/3/4, out of order 2/2/3, mid-tangent 2/2/3, partial 3/3/3, deflection 4/3/3, mentioned-not-answered 3/3/3, sarcasm 2/2/3, answered-before-asked 3/2/3, creator reads the question aloud 4/2/3, late backer 1/2/2, ASR-mangled 3/3/4, injection from the creator 1/2/2, injection from a fan 2/2/2, security-topic questions 2/2/3, the exact demo lines 3/3/2.
- The four few-shot examples in the detector prompt are dev cases `dev-fs-1..4`; `test/ai-fewshots.test.ts` fails if their text appears in val or test.
- Labels were written by one person (the builder). The brief's double-labelling of 30 cases with Cohen's kappa is still to do.

## Unit of scoring

A **pair** is (case, open question). Each pair has an expected verdict. The guard turns the model's verdict into an action: `lock`, `review`, `deflected` or `ignore`.

- **False charge:** action `lock` when the expected verdict is anything other than `answered` (partial, deflected, already covered, not yet). Rate = false charges / negative pairs.
- **Recall:** pairs expected `answered` whose action is `lock`.
- **Review rate:** pairs expected `answered` whose action is `review` (work pushed to the creator).
- **Evidence miss:** a correct lock whose quote lacks the case's evidence keywords (reported, not a target).
- **Late backer:** for late-backer cases, a backer who joined after the guard's `answerStartMs` must get 0 from `chargeForBacking`.
- **Latency:** wall time of the detector API call (p50/p95). This is a proxy for time-to-lock; it excludes speech-recognition lag and the verifier.
- **Cost:** micro-USD per detector call from `usage` and `src/server/ai/pricing.ts`.
- Intervals are Wilson 95%. Haiku 5.5 rejects non-default temperature, so runs differ; the worst run is the headline.

## Pre-registered targets (held-out test split, 5 runs per case)

| Metric | Target |
|---|---|
| False-charge rate, worst of 5 runs | 0 false charges (the Wilson 95% upper bound is reported alongside; with about 40 negative pairs it cannot go below ~0.09) |
| Recall on answered, mean of 5 runs | ≥ 0.80 |
| Review rate on answered, mean of 5 runs | ≤ 0.30 |
| p95 detector latency | ≤ 8 s |
| Late backers charged | 0 |
| Refusals on the security-topic questions | reported (no target; Haiku 5.5 has no server-side fallback, so a refusal routes the room to review) |

A miss on any target is reported as a miss. Synthetic-only results are labelled as such wherever they are quoted (README, video).

## How dev and val are used

1. **Dev** (any number of runs): prompt wording, few-shots, schema and settings. Settings rule: keep `thinking: disabled` + `effort: low` (the brief's preference) unless `adaptive` thinking improves dev raw verdict accuracy by at least 3 points or removes a dev false charge.
2. **Val** (3 runs, once the prompt is frozen): τ only. From one set of val verdicts, the runner recomputes the guard for τ in {0.75, 0.80, 0.85, 0.90, 0.95}. Rule: choose the τ with the highest mean recall among those with **zero worst-run false charges** on val; ties go to the higher τ. If none has zero, choose 0.95 and flag the detector as not ready.
3. **Test**: only after the prompt and τ are frozen, 5 runs, reported once. The runner refuses `--split test` without `--allow-test`. Not run as part of this task.

## Budget

Detector calls cost about $0.0002 each with the rubric cached. The dev and val work in this task is capped at $2 in total (the runner also has `--max-cost-usd`, default $0.50 per invocation).

## Change log

- 2026-10-16: plan written, before any val or test run.
- 2026-10-16, after the first val run (3 runs): two guard fixes driven by val misses, which the plan reserved for τ only. (1) The restatement check counted "yes"/"no" as stopwords, so "yes I use prettier" was rejected as restating "Do you use Prettier?"; yes/no now count as answer words. (2) Spans ending one or two words before their segment end are extended to the end for the stored quote (checks still run on the model's span). Dev and val were re-scored from the saved raw verdicts (no new calls), and τ was chosen on the re-scored val verdicts. Because val influenced the guard, val numbers are slightly optimistic; the test split is untouched. Targets are unchanged.
