# AnswerTab: architecture contract

Fans open one PayPal hold (an authorization) per live stream. They ask questions or back other fans' questions. The browser transcribes the creator, Claude matches spoken answers to open questions, and code cuts the exact quote from the transcript. At the end, the creator approves, each fan gets one capture (`final_capture: true`) for answered questions only, and the rest of the hold is released. A Claude contest desk can refund small shares on its own. The creator is paid with PayPal Payouts after the contest window.

The product reasoning and user flows are summarized in README.md. This file is the build contract: module boundaries, data model, API, events and invariants. Every module must match it. If a module needs a change here, note it in `docs/contract-changes.md` and keep it backward compatible.

## Hard rules

1. **Sandbox only.** `PAYPAL_ENVIRONMENT` must be `sandbox`; the server refuses to start otherwise.
2. **The model never chooses money.** Claude returns verdicts and evidence spans. Deterministic code owns every amount, threshold, PayPal ID and `PayPal-Request-Id`.
3. **Charging needs evidence plus the creator's approval.** A capture includes a backing only when its question has a guard-passed evidence span, or a creator-pointed span that passed the same guard, and the creator approved at End stream. The AI can release money on its own (voids, refunds of up to $5 on a `not_answered` or `deferred` finding).
4. **All amounts are integer cents** (`number`, never float math on dollars). Format with `formatCents()` from `src/shared/money.ts`.
5. **Tab status comes from the authorization**, never from the order. A decline returns HTTP 201 with the order `COMPLETED` and the authorization `DENIED`.
6. **Every PayPal write sends a deterministic `PayPal-Request-Id`** (scheme below), and every PayPal call is written to the `paypal_calls` ledger with secrets and card data removed.
7. **Untrusted text.** Questions, transcript text and contest reasons are data. Prompts put them inside delimiters, and outputs are structured. Nothing from them is executed or used as a URL, ID or amount.
8. **No secrets in the browser.** Only `PAYPAL_CLIENT_ID` (public) reaches the client, via `GET /api/config`.
9. **UI never waits on webhooks.** Webhooks only reconcile.

## Stack

- Node 22+ (`engines`), TypeScript 5.9, ESM (`"type": "module"`).
- Server: Fastify 5, single service that also serves the built web app from `dist/web`.
- DB: Postgres. `DATABASE_URL` set means `pg`; unset means PGlite (in-process WASM Postgres) at `.data/pglite`. Tests use in-memory PGlite. Same SQL for both.
- PayPal:
  - `@paypal/paypal-server-sdk` 2.5.0 (APIMatic-generated) for Orders v2 and Payments v2 (create, authorize, get, capture, void, get authorization, get capture).
  - `@paypal/agent-toolkit` 1.11.0 for `create_refund`, `get_refund`, `get_order` and `get_dispute` (its tools' `execute` functions, called by server code). Use a fresh instance per action.
  - Typed `fetch` for Payouts, webhook signature verification and webhook registration.
- Browser checkout: PayPal JS SDK v6 through `@paypal/react-paypal-js/sdk-v6`. Card fields are the main path and the PayPal button the second.
- AI: `@anthropic-ai/sdk`. Haiku 5.5 (`claude-haiku-5-5`) for intake and detection; Opus 5.5 (`claude-opus-5-5`) for the lock verifier and contest desk. Before writing any Claude call, load the `claude-api` skill for current parameters.
- Speech to text: the Chrome Web Speech API in the creator's browser. The server receives text only.
- Web: Vite + React 19 + React Router 7. Plain CSS with design tokens in `src/web/styles/tokens.css`; no UI framework.
- Tests: Vitest, plus fast-check for money properties.

## Directory ownership

| Path | Owner | Contents |
|---|---|---|
| `src/shared/` | foundation (done) | `types.ts` (API and event shapes), `money.ts` (pure money math) |
| `src/server/config.ts`, `src/server/db/` | foundation (done) | env parsing, DB adapter, `schema.sql`, migrate |
| `src/server/paypal/` | PayPal agent | all PayPal I/O, ledger, request IDs, webhooks, payouts |
| `src/server/ai/` | AI agent | Anthropic client, budgets, intake, detector, guard, verifier, contest desk, prompts |
| `eval/`, `scripts/eval.ts` | AI agent | labeled cases and the eval runner |
| `src/server/domain/` | API agent | room, tab, question and settlement services (business logic, transactions) |
| `src/server/routes/`, `src/server/app.ts`, `src/server/index.ts` | API agent | HTTP routes, SSE hub, static serving |
| `src/server/jobs/` | API agent | job sweeper (auto-void, contest window, payout polling) |
| `src/server/demo/` | Demo agent | replay director, bot fans, judge mode, synthetic run |
| `src/web/` | Web agent | the React app |
| `scripts/sandbox-proof/` | PayPal agent | re-runnable sandbox evidence script |

Modules talk only through the exported functions listed here. The domain layer calls `paypal/*` and `ai/*`; the routes call only `domain/*`.

## Data model (`src/server/db/schema.sql`)

The schema file is the source of truth. Summary:

- `rooms`: id (10-char base58), creator_token_hash (sha256), title, kind (`demo`|`public`), pool (`judge`|`public`), question_price_cents, metoo_price_cents, platform_fee_bps, language, status (`draft`→`live`→`ended`→`settling`→`settled`|`voided`), clock_started_at, ended_at, approve_deadline, contest_window_ends_at, payout_state, llm_spent_micros, created_at, expires_at.
- `fans`: id, room_id, display_name, fan_token (unguessable), is_bot.
- `tabs`: id, room_id, fan_id (unique per room), ceiling_cents, funding (`card`|`paypal`|`bot_card`), order_id, authorization_id, auth_status, state (`opening`|`held`|`declined`|`settling`|`captured`|`voided`|`failed`), capture_id, captured_cents, fee_cents, net_cents, released_cents, refunded_cents, receipt_token, settled_at.
- `questions`: id, room_id, number, asker_fan_id, text, clean_text, cues (jsonb string[]), similar_to, state (`open`|`hidden`|`deflected`|`verifying`|`locked`|`review`|`approved`|`unpaid`), asked_at_ms (room clock), verdict, confidence, span (jsonb EvidenceSpan), quote, quote_at_ms, quote_source (`spoken`|`typed`|`replay`), creator_confirmed, verifier (jsonb), rating (`full`|`half`|`none`|null).
- `backings`: id, question_id, fan_id, tab_id, kind (`ask`|`metoo`), amount_cents, backed_at_ms, charge_cents, state (`reserved`|`released`|`charged`|`refunded`). Unique (question_id, fan_id).
- `segments`: id, room_id, seq, text, words (jsonb string[]), t_start_ms, t_end_ms, source, final.
- `detections`: audit of every model call (model, purpose, tokens, cost_micros, input digest, output, latency).
- `contests`, `payouts`, `paypal_calls`, `webhook_events`, `disputes`, `jobs`, `llm_budget`, `synthetic_runs`.

## Room clock and spans

- Room clock: milliseconds since `rooms.clock_started_at`. The server stamps every final segment on arrival as `t_end_ms = now - clock_started_at - lagMs`, where `lagMs` is the client's measured recognition lag, clamped to 0–3000. Replay segments carry their scripted offsets.
- Words: `segments.words` is `text.split(/\s+/)` after trimming. An `EvidenceSpan` is `{ startSeg, startWord, endSeg, endWord }` (segment `seq` numbers and word indexes, inclusive). The quote is cut by code from those words, never copied from model output.

## Money rules (`src/shared/money.ts`, pure, property-tested)

- `reserve`: asking reserves `question_price_cents`; backing reserves `metoo_price_cents`. A fan's active reservations can never exceed the tab ceiling. A full tab disables asking.
- `chargeForBacking(amount, rating, backedAtMs, answerStartMs)`: `full` → amount; `half` → `Math.floor(amount / 2)` (halves round in the fan's favor); `none` or unapproved → 0. A backer with `backedAtMs > answerStartMs` → 0.
- `tabTotal`: the sum of charges, clamped to the authorized amount.
- Settlement per tab: total > 0 means one capture with `final_capture: true` (PayPal releases the rest); total = 0 means void.
- `refundShare(backingCharge, capturedCents, refundedCents)` = min(backingCharge, capturedCents − refundedCents).
- `payoutAmount` = Σ capture net − Σ refund net (PayPal keeps the original fee on refunds) − platform fee (bps × Σ captured gross, rounded down), never below 0.
- Fees are read from PayPal responses (`seller_receivable_breakdown`, `seller_payable_breakdown`), never estimated in the ledger. Published-rate estimates appear only on the price screen, labeled as estimates.

## PayPal-Request-Id scheme (`src/server/paypal/requestIds.ts`)

`order-{room}-{fan}`, `auth-{room}-{fan}`, `settle-{room}-{fan}`, `void-{room}-{fan}`, `refund-{contest}`, `payout-{room}-{attempt}`. After a 4xx, retry with `-a{n}` only after a GET shows the resource state. `invoice_id` uses `tab-{room}-{fan}` (allowed characters `[A-Za-z0-9_-]`).

## PayPal module API (`src/server/paypal/index.ts`)

```ts
createAuthorizeOrder(p: { roomId; fanId; ceilingCents; funding: 'paypal'|'card'|'bot_card'; botCard?: TestCard }): Promise<{ orderId; status; authorizationId?; authStatus?; raw }>
authorizeOrder(p: { roomId; fanId; orderId }): Promise<{ authorizationId; authStatus; expiresAt?; raw }>
captureTab(p: { roomId; fanId; authorizationId; amountCents; noteToPayer; mock?: string }): Promise<{ captureId; status; grossCents; feeCents; netCents; raw }>
voidTab(p: { roomId; fanId; authorizationId }): Promise<{ status }>
replayCapture(callId: string): Promise<{ captureId; sameAsOriginal: boolean }>
getAuthorization(id), getCapture(id), getOrder(id)
refundShare(p: { contestId; captureId; amountCents; noteToPayer }): Promise<{ refundId; status; grossCents; feeReturnedCents; netCents }>   // via Agent Toolkit create_refund, then get_refund
getDispute(id)
createPayout(p: { roomId; attempt; receiverEmail; amountCents; note }): Promise<{ payoutBatchId; batchStatus }>
getPayoutBatch(id)
verifyWebhook(headers, rawBody): Promise<boolean>
ensureWebhook(url): Promise<{ webhookId }>    // list, then PATCH event_types; create only if missing
getBalances()
```

Every function records ledger rows through `ledger.record({...})`. It never throws a raw SDK error: errors become `PayPalError { name, httpStatus, debugId, details, issue }`.

Sandbox test cards (published by PayPal) live in `src/server/paypal/testCards.ts`. Cardholder name `CCREJECT-REFUSED` triggers a processor decline.

## AI module API (`src/server/ai/index.ts`)

```ts
intakeQuestion(p: { roomId; text; openQuestions: {number; text}[] }): Promise<{ allow: boolean; reason?; cleanText; cues: string[]; similarTo?: number }>
detectAnswers(p: { roomId; openQuestions: OpenQ[]; window: Segment[] }): Promise<Verdict[]>   // Haiku; never throws, returns [] and logs on failure
guardVerdict(v: Verdict, q: OpenQ, window: Segment[]): GuardResult    // pure: { action: 'lock'|'review'|'deflected'|'ignore'; quote?; answerStartMs?; reason }
verifyLock(p: { roomId; question; quote; window }): Promise<{ agree: boolean; reason }>   // Opus, effort low
runContestDesk(p: { contestId }, deps: ContestDeskDeps): Promise<ContestOutcome>             // Opus tool loop
budget: { canSpend(roomId, pool, estMicros): Promise<boolean>; record(roomId, pool, micros) }
```

`Verdict = { questionNumber; verdict: 'answered'|'partial'|'deflected'|'already_covered'|'not_yet'; evidence: EvidenceSpan|null; confidence: number }`.

Guard thresholds: `confidence ≥ TAU` (env `DETECT_TAU`, default 0.80, chosen on the val split; see docs/eval-results.md) → lock; `0.6 ≤ confidence < TAU`, or a `partial` verdict → review; `deflected` → deflected (the card stays open). Locks worth ≥ $10, or with ≥ 3 fans, go to `verifying` until `verifyLock` agrees; on disagreement → review.

Budget: pools `judge` (env `JUDGE_DAILY_MICROS`, default 5_000_000) and `public` (default 2_000_000); per-room cap `ROOM_CAP_MICROS` (default 750_000). When a cap is hit, or Anthropic errors, the room switches to manual confirm. PayPal calls stay real.

No `ANTHROPIC_API_KEY` means the app runs in manual-confirm mode. The creator points at the span, and the same guard runs.

## HTTP API (`src/server/routes/`)

Auth: the creator sends `x-creator-token`; fans send `x-fan-token`. Tokens are 24+ random bytes in base58. The creator console URL keeps the token in the fragment (`/c/:room#k=TOKEN`).

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/healthz` | any | liveness |
| GET | `/api/status` | any | last real checks (PayPal OAuth, webhook, balance, Anthropic, budget, last synthetic run) |
| GET | `/api/config` | any | `{ paypalClientId, environment, testCard, judgeModeAvailable, aiEnabled }` |
| POST | `/api/rooms` | any | create a room `{ title?, kind }` → `{ roomId, creatorToken }` |
| POST | `/api/demo` | any | create a demo room with bots and autoplay replay `{ judgeCode? }` → `{ roomId, creatorToken, stripFans: { fanId, fanToken, displayName }[] }` (the 3 bot fans shown as phones in the presentation layout) |
| GET | `/api/rooms/:id` | any | public room view (prices, questions, state) |
| GET | `/api/rooms/:id/console` | creator | full state: transcript, verdicts, tabs, ledger |
| POST | `/api/rooms/:id/start` | creator | start the room clock (`live`) |
| POST | `/api/rooms/:id/segments` | creator | `{ text, final, source, lagMs? }` transcript input (Mic/Type) |
| POST | `/api/rooms/:id/fans` | any | `{ displayName }` → `{ fanId, fanToken }` |
| POST | `/api/rooms/:id/tab/order` | fan | `{ ceilingCents, funding }` → `{ orderId }` (v6 calls this) |
| POST | `/api/rooms/:id/tab/authorize` | fan | `{ orderId }` → `TabView` |
| GET | `/api/rooms/:id/me` | fan | the fan's tab, backings and receipt link |
| GET | `/api/rooms/:id/review` | creator | the review list (`ReviewItem[]`) after End |
| GET | `/api/rooms/:id/qr` | any | PNG QR code of the fan link |
| POST | `/api/rooms/:id/questions` | fan | `{ text }` → `QuestionView` (intake runs first) |
| POST | `/api/questions/:qid/back` | fan | me-too backing |
| POST | `/api/questions/:qid/hide` | creator | hide; releases reservations |
| POST | `/api/questions/:qid/undo` | creator | undo a lock (free) |
| POST | `/api/questions/:qid/point` | creator | `{ span }` creator-pointed evidence (guard runs) |
| POST | `/api/rooms/:id/end` | creator | end the stream → review list |
| POST | `/api/rooms/:id/settle` | creator | `{ ratings: Record<questionNumber, 'full'|'half'|'none'> }` approve all and settle |
| POST | `/api/ledger/:callId/replay` | creator | resend a stored capture with the same request ID |
| POST | `/api/rooms/:id/close-contest-window` | creator | demo control: close the window now and pay out |
| GET | `/api/receipts/:token` | holder | receipt lines |
| POST | `/api/receipts/:token/verify` | holder | live re-read from PayPal (rate-limited) |
| POST | `/api/receipts/:token/contest` | holder | `{ backingId, reason }` → contest (the desk runs async) |
| POST | `/api/contests/:id/decide` | creator | `{ approve: boolean }` for pending contest refunds |
| GET | `/api/rooms/:id/events` | creator or fan (token query param) | SSE stream |
| POST | `/webhooks/paypal` | PayPal | raw-body verified webhook |

Errors: `{ error: { code, message } }` with HTTP 4xx/5xx. Rate limits are per IP plus per token.

## SSE events (`src/shared/types.ts` `RoomEvent`)

`room.state`, `question.created`, `question.updated`, `backing.created`, `tab.updated`, `segment.added`, `segment.interim`, `verdict` (detector output after the guard), `settle.progress`, `ledger.call`, `contest.updated`, `payout.updated`, `budget.mode` (`ai`|`manual`). There is a heartbeat every 15 s, `retry: 3000`, and on reconnect the client reloads the state.

Fan streams get only public fields plus their own tab. Creator streams get everything except secrets.

## Jobs (`src/server/jobs/`)

A `jobs` table is swept every 5 s (demo) or 30 s (default), from boot:

- `auto_void` at `approve_deadline` (24 h for public rooms, 30 min for demo rooms): void every unsettled tab.
- `close_contest_window` (24 h public, 10 min demo) → create payout.
- `poll_payout` until a terminal status.
- `expire_room` after 7 days: delete transcripts and fans.

Jobs are idempotent and use row locks (`FOR UPDATE SKIP LOCKED`).

## Demo and judge mode (`src/server/demo/`)

- `POST /api/demo` creates a room (`kind: demo`, `pool: judge` when the judge code matches `JUDGE_CODE`), then starts the director.
- Director timeline (`src/server/demo/script.ts`), offsets from room start:
  - bots join and open tabs in parallel through `bot_card` (rotated test cards; one uses `CCREJECT-REFUSED`)
  - bots ask and back questions
  - replay segments arrive (source `replay`): a deflection, an answer locking 3 holds, then a partial answer
- The autoplay part lasts 45 s or less and starts within 10 s. After it, the judge follows a checklist (open own tab, ask, answer by Type, End and settle, receipt, contest, payout).
- A synthetic run (`npm run synthetic`) uses the same director with fresh IDs and records to `synthetic_runs`.

## Web app (`src/web/`)

Routes:
- `/`: landing, pitch and "Start a demo room"
- `/c/:room`: creator console
- `/f/:room`: fan page (join, tab, ask/back, live states)
- `/o/:room`: overlay
- `/r/:token`: receipt
- `/demo/:room`: presentation layout (console plus a fan strip of 3 phones as iframes)
- `/status`

Card states always show an icon and text, never color alone. Interim speech shows a "possible answer" shimmer and never locks.

## Env (`.env.example`)

`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENVIRONMENT=sandbox`, `PAYPAL_WEBHOOK_ID`, `PAYPAL_CREATOR_PAYEE_EMAIL`, `ANTHROPIC_API_KEY` (optional), `DATABASE_URL` (optional), `PUBLIC_BASE_URL`, `JUDGE_CODE`, `DETECT_TAU`, `JUDGE_DAILY_MICROS`, `PUBLIC_DAILY_MICROS`, `ROOM_CAP_MICROS`, `PORT`.
