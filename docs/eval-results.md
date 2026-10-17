# Detector eval results

Date: 2026-10-16. Model `claude-haiku-5-5`, `thinking: disabled`, `effort: low`, `max_tokens` 1500, structured output. Detector + deterministic guard, no verifier, no creator approval (see `docs/eval-plan.md`). **All 83 dev/val cases are synthetic.** The held-out test split (47 cases, also synthetic) was run once afterwards with everything frozen; it missed the false-charge target (see "Held-out test split" below).

## Chosen τ: 0.80

Rule from the plan: the τ in {0.75, 0.80, 0.85, 0.90, 0.95} with the highest mean val recall among those with zero worst-run val false charges; ties go to the higher τ. 0.75 and 0.80 tie (recall 0.963, 0 false charges), so **τ = 0.80**. Set `DETECT_TAU=0.80` in the deployed env (the config default is still 0.85; see `docs/contract-changes.md`).

## Validation split (40 cases, 3 runs, 51 pairs per run: 27 answered, 24 negative)

| Metric | τ = 0.80 (chosen) | τ = 0.85 (default) |
|---|---|---|
| False charges, worst run | 0/24 (Wilson 95% 0 to 0.138) | 0/24 (0 to 0.138) |
| False charges, all 3 runs pooled | 0/72 (0 to 0.051; runs are not independent) | 0/72 |
| Recall on answered, mean (min) | 0.963 (0.963), run 1 Wilson 95% 0.817 to 0.993 | 0.938 (0.926) |
| Review rate on answered | 0.000 | 0.025 |
| Partial answers sent to review | 5/5 each run | 5/5 |
| Deflections shown as deflected | 5/5 each run | 5/5 |
| Late backers charged | 0/6 checks each run | 0/6 |
| Raw verdict accuracy (already_covered = not_yet) | 0.98 | 0.98 |
| Detector latency p50 / p95 / max | 1269 / 1836 / 3159 ms | same calls |
| Cost per call | 104 micro-USD (cache reads 95% of prompt tokens) | same calls |
| Refusals / failed calls | 0 / 120 (security-topic cases included) | same calls |

The only miss at τ = 0.80 is `val-late-1#Q2` in all 3 runs: the model gave `end_word` 18 for a 11-word segment, so the guard rejected the span as out of range (safe, costs recall). At 0.85, `val-tangent-1#Q2` (confidence 0.80) also went to review in 2 of 3 runs.

τ sweep on the same val verdicts (worst-run false charges / mean recall): 0.60 to 0.80: 0/24, 0.963; 0.85: 0/24, 0.938; 0.90: 0/24, 0.914; 0.95: 0/24, 0.123 (almost every lock moves to review).

## Dev split (43 cases incl. the 4 few-shots, 59 pairs per run: 29 answered, 30 negative)

| Setting | Runs | False charges (worst) | Recall at 0.85 | Raw verdict accuracy | p50 / p95 latency | Cost per call |
|---|---|---|---|---|---|---|
| thinking disabled, effort low | 1 | 0/30 | 0.966 | 1.00 | 1370 / 2543 ms | 123 µ$ |
| thinking disabled, effort low | 2 | 0/30 | 0.983 (1.000 at τ 0.80) | 1.00 | 1260 / 1839 ms | 106 µ$ |
| thinking adaptive, effort low | 2 | 0/30 | 0.966 | 0.975 | 1371 / 2485 ms | 125 µ$ |

Adaptive thinking did not beat disabled thinking on dev (the plan's bar was +3 points of raw accuracy or a removed false charge), so the detector keeps `thinking: disabled`.

## Change made after the val run (logged in the plan)

The first val pass scored recall 0.901 at τ 0.85. Two misses were guard bugs, not model errors: `"yes I use prettier"` was rejected as a restatement of "Do you use Prettier?" because "yes" counted as a stopword, and spans that stop one or two words before the segment end produced clipped quotes. The guard now counts yes/no as answer words and extends such spans to the segment end (quote only; all checks run on the model's span). Dev and val were re-scored from the saved verdicts with no new API calls; the numbers above are after the fix. The τ rule was applied to the re-scored verdicts.

## Spend

About $0.038 for 335 detector calls in the eval, plus about $0.03 of smoke tests (detector, intake, Opus verifier, contest desk). Under the $2 cap.

## Read with care

- Synthetic, single-labeller data: clean punctuation, generous timing, and the builder wrote both the cases and the prompt. Real speech will be harder; the 40 real-audio cases and the 30-case double-labelling are still owed.
- Dev is saturated (recall 1.0 at τ 0.80, accuracy 1.0), so it no longer discriminates between prompt changes. Harder dev cases should come from real audio.
- With 24 val negatives, "0 false charges" still allows a true rate of up to ~14% (Wilson upper bound). The held-out run will narrow this only slightly; the product's real protection is the guard plus the creator's approval plus the Opus re-check of big locks.
- Latency is the API call only. Time-to-lock adds speech-recognition lag, the scheduler trigger, and the verifier for big locks (~3 s per Opus call in smoke tests).

Run summaries: `eval/runs/2026-10-16T08-*.json` (labels inside). Raw verdicts are in the matching `.raw.jsonl` files, which are gitignored.

## Held-out test split, run once (2026-10-16, synthetic)

Pre-registered in `docs/eval-plan.md`; run once with the detector prompt, few-shots, settings and τ = 0.80 frozen (nothing was changed before or after it). Command: `npm run eval -- --split test --allow-test --runs 5 --tau 0.80`. 47 cases, **all synthetic**, 5 runs, 60 pairs per run (33 answered, 27 negative). Summary: `eval/runs/2026-10-16T16-02-42-362Z.json`.

| Metric (held-out test, synthetic) | Pre-registered target | Result | Met? |
|---|---|---|---|
| False charges, worst of 5 runs | 0 | **1/27 = 0.037** (Wilson 95% 0.007 to 0.183) | **Missed** |
| False charges, all 5 runs pooled | reported | 1/135 (Wilson 95% 0.001 to 0.041; runs are not independent) | - |
| Recall on answered, mean of 5 runs | ≥ 0.80 | 0.994 (min 0.970; run 1 Wilson 95% 0.896 to 1.0) | Met |
| Review rate on answered, mean of 5 runs | ≤ 0.30 | 0.000 | Met |
| p95 detector latency | ≤ 8 s | 1877 ms (p50 1288, max 3231) | Met |
| Late backers charged | 0 | 0/25 checks (5 per run) | Met |
| Refusals on security-topic questions | reported | 0 refusals, 0 failed calls of 235 | - |
| Partials sent to review / deflections shown as deflected | reported | 25/25 / 25/25 | - |
| Raw verdict accuracy (already_covered = not_yet) | reported | 0.95 | - |
| Cost per call | reported | 107 micro-USD (cache reads 94% of prompt tokens) | - |

**The miss.** `test-sarcasm-1#Q1`, run 4 only. Question: "Do I need to comment every line of code?"; transcript: "every line, definitely, i plus plus, comment, increment i, very helpful" (sarcasm, labelled `not_yet`). The model said `answered` in all 5 runs, with confidence 0.55, 0.42, 0.40, **0.80** and 0.45; the guard locked the 0.80 one because it is exactly τ. In the product that lock would still need the creator's approval at End stream (and the Opus re-check if it held $10 or 3 backers), but by the pre-registered metric it is a false charge, and it is reported as one. τ was **not** changed: the sweep shows 0.85 would have avoided it, but choosing τ on the test split is what the plan forbids. The τ sweep is in the summary file for transparency only.

**The other non-lock.** `test-direct-1#Q2`, run 4: the model gave `end_word` 20 for a 11-word segment; the guard rejected the span as out of range (safe, costs recall), the same failure mode as `val-late-1#Q2` on val.

## Demo-lines soak (2026-10-16, synthetic)

The 8 `demo_lines` cases (dev 3, val 3, test 2: the autoplay's exact sentences, some ASR-lowercased and some with filler between them) 30 times each at τ = 0.80, prompt frozen. Command: `npm run eval -- --split all --category demo_lines --allow-test --runs 30 --tau 0.80` (`--split all` with `--category` was added for this; it includes test cases, so it needs `--allow-test`, and nothing was tuned on it). Summary: `eval/runs/2026-10-16T16-05-07-545Z.json`.

| Check (brief: 29/30 required) | Runs fully correct | Pairs |
|---|---|---|
| Deflection shown as deflected | **30/30** | 60/60 |
| Answer locked | **30/30** | 180/180 |
| Partial sent to review | 30/30 | 150/150 |
| False charges | 0 in every run | 0/300 negative pairs (Wilson 95% 0 to 0.013, pooled) |

Latency p50 1296 ms, p95 1856 ms; 0 failed calls of 240. The script wording did not need to change. This is the detector statistic on fixed transcripts; replay-to-lock timing in the running app (scheduler trigger, the Opus verifier for the $12 lock, polling) comes from the hosted synthetic runs instead (`details.director.replayToLockMs`, see `docs/runbook.md`), labelled as replay segments, not speech.

## Spend (this section)

$0.0252 (235 calls, held-out) + $0.0298 (240 calls, soak) = **$0.055**, plus one offline re-score from saved verdicts (no calls).
