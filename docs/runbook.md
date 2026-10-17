# Runbook: the hosted AnswerTab demo

Operating the judge demo on Render (Blueprint: `render.yaml`). Sandbox only: the server refuses to start unless
`PAYPAL_ENVIRONMENT=sandbox`. After the Nov 12 submission, only operations change (deploy the tagged commit,
restart, rotate keys, add credit). No code changes.

Reference numbers from the first real synthetic run (2026-10-16, local, real sandbox and real Claude): passed in
94 s; autoplay started at 4.6 s and finished at 37.3 s; 21 PayPal calls, 0 errors; LLM cost $0.036
(contest desk $0.030, verifier $0.005, detector $0.0008, intake $0.0004); payout batch SUCCESS 33 s after it was sent.

## 1. First setup

1. PayPal: use the separate sandbox app `answertab-demo` (development uses `agent-hack-us`). Note its client
   ID and secret, and the US sandbox personal account that receives creator payouts.
2. Render: New > Blueprint > this repo. Plan A (default) is a paid web service and Postgres on the hackathon
   credits; plan B (free web service, outside keep-warm ping, Neon free Postgres) is described at the top of
   `render.yaml`. Render asks once for every `sync: false` value (section 3).
3. When the service is live: register the webhook (section 4), set `PAYPAL_WEBHOOK_ID`, restart.
4. Check `/status` (section 8) and start a demo room from the landing page.

## 2. Deploy a tag

Auto-deploy is off (`autoDeploy: false`, `autoDeployTrigger: off`). Deploy only tagged commits.

```sh
npm run typecheck && npx vitest run      # the same checks CI runs
git tag -a submission-2026-11-12 -m "Devpost submission"
git push origin submission-2026-11-12    # CI runs on tags too: wait for green
git rev-list -n 1 submission-2026-11-12  # the commit to deploy
```

Then Render dashboard > `answertab` > Manual Deploy > Deploy a specific commit, and pick that commit (the tag
must be on the service's branch). With the Render API instead:
`curl -X POST -H "Authorization: Bearer $RENDER_API_KEY" -H 'Content-Type: application/json' -d '{"commitId":"<sha>"}' https://api.render.com/v1/services/<service-id>/deploys`
(check the field name against Render's API reference before relying on it).

After the deploy: `/healthz` answers, `/status` is green, and one demo room autoplays (section 7).
Rollback is the same step with the previous tag's commit. Migrations are additive (`CREATE ... IF NOT EXISTS`
at boot), so a rollback needs no database step.

## 3. Environment variables

Fixed in `render.yaml`: `NODE_VERSION=22`, `NODE_ENV=production`, `NPM_CONFIG_INCLUDE=dev` (the build needs
tsc and vite), `PAYPAL_ENVIRONMENT=sandbox`, `TRUST_PROXY=1`, `LOG_LEVEL`, `DETECT_TAU=0.80`, the budget caps
(`JUDGE_DAILY_MICROS`, `PUBLIC_DAILY_MICROS`, `ROOM_CAP_MICROS`), `ROOMS_PER_IP_PER_DAY` (public rooms per IP per
day, default 20) and `SYNTHETIC_EVERY_MIN`. Section 9 lists the values for the judging window. `DATABASE_URL`
comes from the Render database. Render sets `PORT`.

Entered in the dashboard (Environment tab), never committed:

| Variable | Value |
|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | the `answertab-demo` sandbox app |
| `PAYPAL_WEBHOOK_ID` | printed by `npm run webhook:register` (section 4) |
| `PAYPAL_CREATOR_PAYEE_EMAIL` | the sandbox personal account that receives payouts |
| `ANTHROPIC_API_KEY` | key from the separate demo workspace with a hard monthly limit; unset = manual-confirm mode |
| `PUBLIC_BASE_URL` | the public https origin, no trailing slash |
| `JUDGE_CODE` | the code in the Devpost testing instructions |

Optional: `DEMO_AUTOPLAY=0` turns the judge autoplay off (rooms still get their bots). `sync: false` values are
asked for only when the Blueprint is first applied; later changes are made in the dashboard. Changing an
env var restarts the service.

## 4. Register the webhook

PayPal must reach the public URL, so `PUBLIC_BASE_URL` has to be the https origin of the deployed service. Run
it from a checkout whose `.env` holds the `answertab-demo` client ID and secret:

```sh
PUBLIC_BASE_URL=https://<host> npm run webhook:register
```

It lists the app's webhooks, updates the event types on the one for `<host>/webhooks/paypal` or creates it,
and prints `PAYPAL_WEBHOOK_ID=...` (an ID, not a secret). Put it in the dashboard; the service restarts.
`/status` shows `paypal_webhook` green within 5 minutes. Re-run it whenever the host name changes. The UI never
waits on webhooks; they only reconcile and add badges: the payout badge, disputes, "Confirmed by PayPal webhook"
on receipts (`tabs.capture_webhook_at`, set by the first verified `PAYMENT.CAPTURE.*` event reporting a
completed capture) and on contest refunds (`contests.refund_webhook_at`), and the console's list of the room's
verified events (`ConsoleView.webhooks`, newest 50). Sandbox delivery can lag minutes; a missing badge is not
an error.

## 5. Rotate keys on Dec 16

After judging closes, rotate everything (all sandbox, but rotate anyway):

1. PayPal developer dashboard > `answertab-demo` > regenerate the secret (or delete the app; the webhook goes
   with it). Update `PAYPAL_CLIENT_SECRET` (and the ID if the app was replaced).
2. Anthropic console > the demo workspace > revoke the key. Set a new one only if the demo stays up; without a
   key the app runs in manual-confirm mode.
3. Change `JUDGE_CODE` (or unset it to close the judge pool).
4. Render Postgres (or Neon): reset the database password; Render updates `DATABASE_URL` for the service.
5. Judge-buyer sandbox accounts: change their passwords in the sandbox accounts page (there is no API).
6. Check `/status`, then search the repo once more: `gitleaks git .` should report nothing.

## 6. When the PayPal sandbox is degraded

Symptoms: bot holds stay "opening" or fail, `paypal_oauth` or `paypal_balance` red on `/status`, 5xx or
`TIMEOUT` rows in the console's ledger panel, the synthetic run failing at `bot_holds` or `settle`.

1. Confirm: https://www.paypal-status.com (sandbox components) and the ledger rows' `debug_id`s.
2. Do not redeploy or change code: every PayPal write uses a deterministic `PayPal-Request-Id`, and
   interrupted settlements are resumed by the job sweeper (tabs left `settling` are re-read before any retry).
   A settle with unknown outcomes schedules a `settle_retry` job (1 min, then backoff up to 15 min), and a
   restart resumes every room left `settling` at boot. A payout whose response was lost is resent with the
   same `sender_batch_id`, so it can never pay twice.
3. Point judges to the recorded run: the demo video and the last passed synthetic run's PayPal IDs
   (`GET /api/status` returns them as `lastPassedRun`; the landing page shows it when a PayPal check fails).
4. If one room is stuck after recovery, press Settle again from its console (POST `/settle` is idempotent and
   resumable): repeated settles share one run and never capture twice. Unapproved rooms void themselves at the
   approve deadline (30 min for demos); rooms nobody ends are ended after 1 h (demo) or 12 h (public).
   Contests interrupted by a restart move to `failed` at boot, so the creator decides them in the console.
5. When Anthropic is degraded instead, rooms switch to manual confirm on their own (the console shows a toast); PayPal
   calls stay real. Nothing to do unless it lasts: then check the workspace limit and `llm_budget_*` on `/status`.

## 7. Burn-in Nov 5-11 with synthetic runs

A synthetic run (`src/server/demo/synthetic.ts`) is the judge path with fresh IDs: a demo room with the bots
(one processor decline, plus a bot whose hold is voided), the 45 s autoplay, End, settle with Q2 rated half,
a live receipt verify, a contest of the Q2 share through the receipt token, the contest desk's refund, Close
contest window, and the Payouts batch polled to a terminal status. It records `ok` and details (PayPal IDs,
timings, LLM costs; no tokens) in `synthetic_runs`; `/status` shows the latest. About $0.04 of LLM per run,
billed to the judge pool when `JUDGE_CODE` is set (hourly runs: about $1 a day of the $5 pool).

Schedule:

| When | What |
|---|---|
| From the first deploy, Nov 5-11 included | `SYNTHETIC_EVERY_MIN=60` (hourly, the `render.yaml` default). Three full judge-path runs a day by hand: Chrome, Safari, Firefox and one phone, following the checklist in the console. |
| Nov 12 - Dec 15 | `SYNTHETIC_EVERY_MIN=1440` (daily). Check the judge-buyer accounts by hand every 2 days in December. |
| Dec 16 | `SYNTHETIC_EVERY_MIN=0`, then rotate keys (section 5). |

The API boot starts the in-server schedule (`startSyntheticScheduler()` in `src/server/index.ts`; first run
1 minute after boot, then every `SYNTHETIC_EVERY_MIN` minutes; off locally unless set). On `/status`, a
passed run older than twice the interval shows `synthetic_run` as stale. For a one-off run, open Render >
`answertab` > Shell and run `npm run synthetic` (exit code 0 = passed; `-- --json` prints the stored details).
The database accepts only private-network connections, so run it there rather than from a laptop.

Reading results (Render Shell):

```sh
node -e "const pg=require('pg');const c=new pg.Client({connectionString:process.env.DATABASE_URL});c.connect().then(()=>c.query(\"SELECT id, started_at, ok, room_id, details->'timings'->>'total' AS ms, details->'costs'->>'llmMicros' AS micros FROM synthetic_runs ORDER BY started_at DESC LIMIT 24\")).then(r=>{console.table(r.rows);return c.end()})"
```

A failed run's `details.checks` names the step (`bot_holds`, `autoplay_timing`, `detector_script`, `review_q1`,
`settle`, `receipt_verify`, `contest_refund`, `payout`) and `details.paypal.ledger.errors` carries the debug IDs.
Results stay in the database and on `/status`, never in the repo.

Locally: `PGLITE_DIR=.data/pglite-synthetic npm run synthetic` (real sandbox, real Claude if the key is set).
Use a PGlite folder no running server has open.

**Soak table (replay segments, not speech).** Each run stores, for every scripted `say` step, the room-clock
time its replay segment was posted (`atMs`), when the director first saw the card in the expected state
(`reachedAtMs`, polled, so an upper bound) and the difference (`replayToStateMs`); `details.director.replayToLockMs`
is the Q1 answer's (the $12 lock, Opus verifier included), null unless it locked. After a week of hosted hourly
runs, report n, pass rate and the median from the Render Shell:

```sh
node -e "const pg=require('pg');const c=new pg.Client({connectionString:process.env.DATABASE_URL});c.connect().then(()=>c.query(\"SELECT count(*) AS n, round(avg(CASE WHEN ok THEN 1 ELSE 0 END)::numeric, 3) AS pass_rate, percentile_cont(0.5) WITHIN GROUP (ORDER BY (details->'director'->>'replayToLockMs')::int) AS median_replay_to_lock_ms, max((details->'director'->>'replayToLockMs')::int) AS max_ms FROM synthetic_runs WHERE finished_at > now() - interval '7 days'\")).then(r=>{console.table(r.rows);return c.end()})"
```

| Week ending | Runs (n) | Pass rate | Median replay-to-lock | Max | Notes |
|---|---|---|---|---|---|
| 2026-10-16 (local, one run) | 1 | 1/1 | 4.5 s | 4.5 s | real sandbox and Claude; deflection 1.5 s, partial to review 1.3 s |
| _fill in after a week of hosted runs_ | | | | | |

The median ignores runs where Q1 did not lock (null). Label these numbers "replay segments, not speech" wherever
they are quoted: they exclude speech-recognition lag.

## 8. Checking /status

`https://<host>/status` (page) or `curl -s https://<host>/api/status` (JSON `{ checks: [...] }`). The server
re-runs the checks every 5 minutes; reads never call out.

| Check | Green means | When red |
|---|---|---|
| `paypal_oauth` | the app can get a sandbox token | credentials wrong or rotated, or sandbox down (section 6) |
| `paypal_webhook` | `PAYPAL_WEBHOOK_ID` is registered for this host | re-run section 4 |
| `paypal_balance` | the merchant balance can be read | sandbox degraded; the demo can still run |
| `anthropic` | the key works | rooms run in manual-confirm mode; check the key and workspace limit |
| `llm_budget_judge`, `llm_budget_public` | today's pool has budget left | resets at 00:00 UTC; raise `*_DAILY_MICROS` only with credit to spare |
| `synthetic_run` | the latest synthetic run passed | read its `details` (section 7) |

Also watch the Render metrics for memory (512 MB plan) and the service log for `[demo]`, `[synthetic]`,
`[detection]` and `[contests]` lines.

## 9. Judging window settings (Dec 1-15)

Up to 15,000 registrants may open the public URL. If the public LLM pool runs out, a code-less demo room falls
back to manual confirm (the autoplay plays and nothing locks), so raise the public caps for the window. On
Dec 1, in Render > `answertab` > Environment (each change restarts the service; the order does not matter):

| Variable | Default (`render.yaml`) | Dec 1-15 | Why |
|---|---|---|---|
| `ROOMS_PER_IP_PER_DAY` | 20 | **60** | judges behind one office or university IP; judge-code rooms are never limited |
| `PUBLIC_DAILY_MICROS` | 2000000 ($2) | **5000000** ($5) | more public rooms keep AI on before the pool runs out (a full synthetic run, contest desk included, costs about $0.03-0.04) |
| `SYNTHETIC_EVERY_MIN` | 60 | **1440** | one judge-path run a day, so the judge pool stays for judges |

`JUDGE_DAILY_MICROS` stays 5000000 and `ROOM_CAP_MICROS` 750000. Cost stays bounded by the two daily pools, the
per-room cap and the Anthropic workspace's hard monthly limit. The judge link in the Devpost testing
instructions is `https://<host>/?code=<JUDGE_CODE>` (the landing page fills the code in), with the plain URL as
the fallback. On Dec 16 set them back (or `SYNTHETIC_EVERY_MIN=0`) and rotate keys (section 5).

## 10. Live smoke workflow (GitHub Actions)

`.github/workflows/live-smoke.yml` runs every 30 minutes: it GETs `$DEMO_URL/healthz` and `$DEMO_URL/api/status`
and fails when a judge-affecting check (`paypal_oauth`, `paypal_balance`, `anthropic`, `llm_budget_judge`,
`llm_budget_public`) is not ok, is missing, or was last refreshed over 20 minutes ago. `paypal_webhook` and
`synthetic_run` are left to `/status`. The failure message names each failing check with its detail, and the
job summary shows every check. GitHub emails the repository owner about failed scheduled runs (Settings >
Notifications > Actions: "Send notifications for failed workflows only" should be on).

1. Set the repository variable `DEMO_URL` (Settings > Secrets and variables > Actions > Variables), e.g.
   `https://answertab.onrender.com`, no trailing slash needed. Without it each run passes with a warning and
   checks nothing.
2. Test the alert once: Actions > live-smoke > Run workflow with `force_failure` ticked; the email should arrive
   within minutes. Then run it without the box: it should be green against the hosted URL.
3. Keep it enabled through Dec 15: GitHub disables scheduled workflows after 60 days without repository
   activity. If the last commit is from early November, re-enable it in the Actions tab on Dec 1, or run
   `gh workflow enable live-smoke.yml` (and `gh workflow run live-smoke.yml` to check it).
4. GitHub's cron can start late by several minutes under load. For plan B (a free Render service that sleeps),
   use an outside uptime monitor at 5-minute intervals for keep-warm, not this workflow.

When it goes red: section 6 (PayPal), or the `anthropic` / `llm_budget_*` rows in section 8.
