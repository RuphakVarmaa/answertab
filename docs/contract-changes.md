# Contract changes and notes

## PayPal module (src/server/paypal), 2026-10-16

All additive; every function in ARCHITECTURE.md "PayPal module API" exists with the listed parameters.

- **Optional `attempt?: number`** on `createAuthorizeOrder`, `authorizeOrder`, `captureTab`, `voidTab`. It adds the `-a{n}` suffix from the request-ID scheme. The domain passes it (e.g. from `tabs.settle_attempt`) only after a GET showed the earlier attempt's state.
- **Optional ledger context** `ctx?: { roomId?, fanId?, tabId?, contestId? }` as a second argument on `getAuthorization`, `getCapture`, `getOrder`, `getDispute`, `getPayoutBatch`, so reads show up in the room's ledger panel. Without it the row has no room.
- **Extra result fields**: `createAuthorizeOrder` also returns `expiresAt`, `processorResponse`, `declineReason` (set when the authorization is DENIED; use it for `TabView.declineReason`), `approveUrl` and `ledgerCallId`. `captureTab` also returns `statusReason`, `finalCapture`, `invoiceId`, `authorizationId`, `ledgerCallId` (the id `POST /api/ledger/:callId/replay` takes). `refundShare` also returns `path` (`toolkit` or `sdk-fallback`), `captureId`, `raw`. `createPayout` also returns `senderBatchId`, `recovered`. `replayCapture` also returns `originalCaptureId`, `httpStatus`.
- **`feeCents` / `netCents` are `number | null`** on captures: PayPal can omit the breakdown (PENDING). Never estimate them.
- **`raw` is always redacted** (no card data, payer name/phone/address; emails masked). Do not expect payer PII in it.
- **Card funding**: the order has no `payment_source`; brand_name / NO_SHIPPING / CONTINUE go in `application_context`, because `payment_source.card.experience_context` has no such fields. The browser's card fields attach the card (confirm-payment-source), then the server calls `authorizeOrder`. Verified in sandbox.
- **Payouts write one table**: `createPayout` runs `UPDATE payouts SET payout_batch_id = COALESCE(payout_batch_id, $2), batch_status = ... WHERE sender_batch_id = $1` (best effort, no insert). The domain inserts the payouts row (sender_batch_id `payout-{room}-{attempt}`) before calling. On a duplicate sender_batch_id PayPal returns 400 (no replay); `createPayout` then answers from that stored id or the batch linked in the error, with `recovered: true`. `isDuplicatePayoutBatch(e)` is exported.
- **Ledger helpers** exported for the API layer: `onLedgerCall(listener) => unsubscribe` (event `{ roomId, call: LedgerCallView }`, emitted even if the DB write failed), `listLedgerCalls(roomId, limit?)`, `getLedgerCall(id)`. Ledger rows link `tab_id` by (room, fan) or contest automatically.
- **Exports for other modules**: `JUDGE_TEST_CARD` (for `GET /api/config` `testCard`), `TEST_CARDS`, `botCard(i, name?)`, `declineCard()`, `isDeclined(raw)`, `WEBHOOK_EVENT_TYPES`, `listWebhooks()`, `PayPalError` / `isPayPalError` / `toPayPalError`, `paypalLimit` (max 4 PayPal calls in flight).
- **Errors**: besides PayPal's own names, local failures use `httpStatus: 0` with names `NETWORK_ERROR`, `TIMEOUT`, `INVALID_ARGUMENT`, `INVALID_RESPONSE`, `LEDGER_CALL_NOT_FOUND`, `NOT_REPLAYABLE`, `TOOLKIT_ERROR`, `NOT_SANDBOX`. `PayPalError.links` carries the error body's links.
- **Foundation note (not changed)**: `tsconfig.server.json` includes only `src/`, so `scripts/*.ts` are not type-checked by `npm run typecheck`. Consider a `tsconfig.scripts.json`.

## AI module (src/server/ai), 2026-10-16

Every function in ARCHITECTURE.md "AI module API" exists with the listed parameters (import from `src/server/ai/index.ts`). Additions are backward compatible.

- **`OpenQ`** (defined in `src/server/ai/types.ts`): `{ number, text (clean_text), askedAtMs, cues?, backers?, lockedCents?, backings?: { amountCents, backedAtMs }[] }`. Pass `backings` when you can: the guard then counts only backers who joined before the answer for the verifier rule and returns `backers` / `lockedCents`.
- **`GuardResult`** adds `span`, `quoteAtMs` (= `answerStartMs`, the start segment's `tStartMs`), `needsVerifier`, `backers`, `lockedCents`, `confidence`. Store `quote`, `span`, `quote_at_ms`, `answer_start_ms` from it. `action: 'lock'` with `needsVerifier: true` means: set `verifying`, call `verifyLock`, lock on agree, review on disagree.
- **Guard details the domain should know**: spans must be in range, ≥ 4 words, start no earlier than `asked_at_ms - 2000` (stamping tolerance), and not restate the question; spans over 120 words go to review. A span that stops 1-2 words before its segment's end is extended to the end for the stored quote. Partial verdicts below 0.6 confidence are ignored (the review band floor applies to partial too).
- **`guardCreatorSpan(span, q, window)`** for `POST /api/questions/:qid/point`: same span checks, locks without a confidence threshold, never needs the verifier.
- **`intakeQuestion`** takes an optional `roomTitle` and returns `source: 'model' | 'fallback'`. Without a key, on budget hits or API errors it falls back to deterministic rules and allows the question (cues from content words, `similarTo` by word overlap). `reason` values: `abuse`, `injection`, `off_topic`, `empty`, `too_long`.
- **Manual-mode signal**: `setAiTroubleListener(fn)` receives `{ roomId, purpose, reason, detail }` with reason `no_client | budget | timeout | rate_limit | api_error | connection | refusal | max_tokens | bad_output`. Suggested: switch the room to manual (`rooms.ai_mode = 'manual'`, emit `budget.mode`) on `budget` and `no_client`, and after repeated API errors; a single `refusal` on one window should not flip the whole room.
- **`DetectorScheduler`** (one per live room): `new DetectorScheduler({ roomId, onVerdicts, enabled: () => room is in ai mode })`, then `setOpenQuestions(openQs)` whenever the open set changes and `onSegment(segment)` for every final segment. `onVerdicts({ verdicts, openQuestions, window, trigger })` is where the domain runs `guardVerdict` per verdict and updates cards. `stop()` at End stream.
- **Contest desk**: `runContestDesk({ contestId, resume? }, deps: ContestDeskDeps)` (interface in `src/server/ai/contestDesk.ts`). Deps compute everything with money or IDs: `getShare` (use `refundShare()` from money.ts), `refund` (request ID `refund-{contest}`), `requestCreatorApproval`, `uphold`, plus `load` / `persist` for `contests.messages` and `contests.progress`. The policy gate (`refundPolicy`) runs in code before `refund` is ever called. Returns `ContestOutcome { state: refunded | pending_creator | upheld | failed, finding, evidence, explanation, refundId, refundCents, turns, costMicros }`; on `failed`, route the contest to the creator. After `POST /api/contests/:id/decide`, issue (or skip) the refund in the domain, then call `runContestDesk({ contestId, resume: { approved, refundId } }, deps)` to append the creator's decision and get the closing explanation (history stays append-only).
- **Deviation from the brief's tool signatures**: `refund_contested_share` takes `{ finding, evidence, explanation }` and `uphold_charge` takes `{ evidence, explanation }`. No `contest_id`, amount or ID is passed by the model; the `explanation` field is added so the fan/creator text comes from the same decision call instead of an extra Opus turn.
- **Audit rows**: every model call writes `detections` (`purpose` intake | detect | verify | contest). `input_tokens` holds the total prompt tokens (uncached + cache write + cache read); `output` is `{ inputDigest, stopReason, cacheWriteTokens, requestId, result }` where `result` holds verdicts or tool names, never transcript text.
- **Budget**: `budget.canSpend / record / status`. The day is the UTC date computed in Node (not Postgres `current_date`, which depends on the session time zone).
- **τ**: chosen 0.80 on val by the pre-registered rule (`docs/eval-results.md`). `config.ts` and `.env.example` (foundation-owned) still default `DETECT_TAU` to 0.85; please set `DETECT_TAU=0.80` there. The local `.env` currently has 0.85.
- **Test helper**: `src/server/ai/fakeClient.ts` (`scriptedClient`, `fakeMessage`) plus `setAnthropicClientForTests` let other modules (domain tests, the synthetic run) script model replies with no network.

## API agent (src/server/domain, routes, jobs, app.ts, index.ts, sse.ts, status.ts, demo/index.ts), 2026-10-16

Every route in the ARCHITECTURE.md HTTP API table exists. Additions are backward compatible. Errors are always `{ error: { code, message, ...extra } }`.

**Response shapes not typed in `src/shared/types.ts`**
- `POST /api/rooms` body `{ kind, title?, language?, judgeCode? }` -> 201 `{ roomId, creatorToken, pool, fanUrl, overlayUrl, consoleUrl }` (`consoleUrl` carries `#k=TOKEN`). `POST /api/demo` -> 201 `{ roomId, creatorToken, stripFans, fanUrl, overlayUrl, consoleUrl }`.
- `POST /api/rooms/:id/start` -> `RoomView`. `POST /api/rooms/:id/fans` -> 201 `{ fanId, fanToken, displayName }`.
- `POST /api/rooms/:id/segments` -> 200 `{ segment, interim: false }` (final) or 202 `{ segment: null, interim: true }` (interim: only `segment.interim` is emitted, nothing stored).
- `POST /api/rooms/:id/tab/order` -> `{ orderId, tab: TabView }`. `POST .../tab/authorize` -> `TabView`; 409 `order_not_approved` until the browser step is done; a decline is 200 with `state: 'declined'` and `declineReason`.
- `GET /api/rooms/:id/me` -> `FanSelfView & { receiptUrl }`.
- `POST /api/rooms/:id/end` and `GET .../review` -> `ReviewItem[]` (bare array): every non-hidden card, locked first. `lockedCents` counts only backers who joined before the answer started.
- `POST /api/rooms/:id/questions` body `{ text, checkSimilar? }` -> 201 `QuestionView`. With `checkSimilar: true` and an intake `similarTo`, it answers 409 `similar_question` `{ similarTo, similarText }` and reserves nothing (the "back it instead?" step); without it the card is created with `similarTo` set. Other errors: 422 `question_rejected` `{ reason }` (never charged), 409 `tab_full` `{ ceilingCents, reservedCents, neededCents }`, `no_tab`, `tab_declined`, `tab_not_held`, `room_closed`.
- `POST /api/questions/:qid/back|hide|undo|point` -> `QuestionView`. back: 409 `backing_closed` (answered card), `already_backed`, `tab_full`. point: 422 `span_rejected` `{ reason }` (same guard).
- `POST /api/rooms/:id/settle` body `{ ratings? }` -> `{ room: RoomView, tabs: (TabView & { displayName, isBot })[], errors: { tabId, message }[] }`. Locked cards default to `full`; review cards are charged only when rated `full`/`half`; open/deflected cards are unpaid whatever is sent. 409 `not_ended`, `still_verifying`. Concurrent and repeated calls share one run (never a second capture).
- `POST /api/rooms/:id/close-contest-window` (demo rooms only) -> `{ payout: PayoutView | null }`; 403 `demo_only`, 409 `contests_pending` / `not_settled` / `nothing_to_pay`, 503 `payout_unconfigured`.
- `GET /api/rooms/:id/console` -> `ConsoleView` plus `review: ReviewItem[]`, `disputes: DisputeView[]` (`{ id, tabId, status, reason, amountCents, evidencePack, updatedAt }`), `aiModeReason`, `approveDeadline`.
- `GET /api/receipts/:token` -> `ReceiptView` plus `roomId`, `roomStatus`, `captureStatus`, `disputeOpen`, `contestWindowOpen`. Quote fields are set only for approved answers.
- `POST /api/receipts/:token/verify` -> `{ checkedAt, authorization: { id, status, amountCents } | null, capture: { id, status, grossCents, feeCents, netCents } | null, matches, mismatches: string[], receipt }`; 429 within 10 s per receipt.
- `POST /api/receipts/:token/contest` -> 201 `ContestView` (state then moves `open -> deciding -> refunded | pending_creator | upheld | failed` over SSE `contest.updated`, progress notes included). 409 `window_closed`, `not_charged`, `already_contested`, `dispute_open`. `POST /api/contests/:id/decide` works on `pending_creator` and `failed` (the desk could not decide) and returns `ContestView`; the desk's closing explanation follows over SSE.
- `POST /api/ledger/:callId/replay` -> `{ captureId, sameAsOriginal, originalCaptureId, httpStatus }`; 409 `not_replayable`.
- `GET /api/status` -> `{ checks: StatusCheck[] }` with names `paypal_oauth`, `paypal_webhook`, `paypal_balance`, `anthropic`, `llm_budget_judge`, `llm_budget_public`, `synthetic_run` (refreshed every 5 min).

**SSE** `GET /api/rooms/:id/events?token=`: the creator token or a fan token; no token is the public (overlay) stream; a bad token is 401. Frames are `data: <RoomEvent JSON>` without `event:` names, after `retry: 3000` and an initial `room.state`; heartbeat comments every 15 s. Audiences: `ledger.call`, `verdict`, `payout.updated` creator only; `tab.updated` to the creator (with `displayName`, `isBot`) and to that fan (own tab only); `contest.updated` to the creator and the contesting fan; the rest to everyone. Hidden cards reach non-creators as `question.updated` with `state: 'hidden'` and empty text.

**Semantics worth knowing**
- A capture that comes back PENDING leaves the tab `state: 'settling'`, `authStatus: 'PENDING'`, `feeCents: null` until PayPal (webhook, verify, or the payout step) reports COMPLETED; never shown as paid. Proposal for foundation: add `captureStatus` to `TabView` (the receipt already has it).
- Creator views carry `receiptToken` only for bot tabs; a real fan's receipt link stays with that fan (`/me`).
- `failed` tabs (a definitive PayPal refusal at settle) are terminal in this version; nothing is charged.
- Payout amount uses PayPal's capture nets and each refund's own net read back with `get_refund` at payout time (falls back to the gross refund, which can only lower the payout). Proposal for foundation: a `contests.refund_net_cents` column would save those reads.
- Undoing a lock records its answer start in memory; later verdicts citing the same or earlier transcript for that card are ignored (lost on restart).
- At boot, cards left `verifying` by a restart go to `review`, and live rooms get their detector back.
- Abuse limits: 20 public-pool rooms per IP per day (judge code bypasses), per-route limits keyed by IP + token (IP only where no token applies), a 1500/min per-IP ceiling, 64 KB bodies (webhooks 128 KB, raw body kept).
- New optional env: `TRUST_PROXY` (proxy hop count to trust for the client IP; Render: `1`), `LOG_LEVEL`.

**For the demo agent**
- `src/server/demo/index.ts`: `startDemoRoom({ judgeCode, ip })`, `setDemoDirector(fn)` (called with `{ roomId, creatorToken, pool, stripFans, declinedFan, tabsReady }` after the room is live), `demoTabsReady(roomId)`.
- Domain calls a director needs (from `src/server/domain/index.ts`): `findFan(roomId, fanToken)` -> FanRow, `askQuestion(roomId, fan, { text })`, `backQuestion(questionId, fan)`, `addSegment(roomId, { text, final: true, source: 'replay', scripted: { tStartMs, tEndMs } })` for scripted offsets, `detectionIdle`, `triggerDetection`, `settleRoom`, `closeContestWindow`, `setNowForTests`.
- Test kit `src/server/domain/testkit.ts`: `makeFakePayPal(actual)` (fixture-shaped fake for `vi.mock` of the PayPal index, with failure injection), `routedClaude({ intake, detect, verify, contest })` (answers by call kind; detector rules find phrases in the rendered transcript), `toolUse`.

## Web app (src/web), 2026-10-16

No shared type changes. The client is tolerant of small shape choices; these are the assumptions and requests for the API agent.

- **SSE auth query**: `GET /api/rooms/:id/events?token=TOKEN&k=TOKEN&role=creator` (creator) or `?token=TOKEN&t=TOKEN&role=fan` (fan). Read `token`; the aliases match the page URLs. Both SSE styles work: unnamed `data:` lines whose JSON has `type`, or named `event: question.updated` lines. Unknown types are dropped. The client reloads full state on every (re)open, so the server needs no replay buffer.
- **Lists**: `POST /end`, `GET /review` may return `ReviewItem[]` or `{ items }`; `GET /api/status` may return `StatusCheck[]` or `{ checks }`.
- **Intake rejection** (`POST /questions`): 4xx with the reason string (`abuse | injection | off_topic | empty | too_long`) in `error.code` or `error.message`, e.g. `422 { error: { code: 'intake_rejected', message: 'off_topic' } }`. Nothing must be reserved. `similarTo` on the created `QuestionView` shows a "back #N instead?" hint.
- **Guard rejection** (`POST /api/questions/:qid/point`): 4xx whose `error.message` is shown to the creator verbatim (e.g. "Span too short"). The UI pre-checks the 4-word minimum.
- **Fans see backings made elsewhere** only after a reload: the fan page re-fetches `/me` (debounced) on `tab.updated`, `backing.created` and `question.created`. Please emit `tab.updated` to the fan whenever its `reservedCents`, state or capture changes (bot fans in the demo strip depend on it for "$3 locked").
- **Verify** (`POST /api/receipts/:token/verify`): preferred `{ verifiedAt, records: [{ kind: 'authorization'|'capture'|'refund'|'void', id, status, amountCents? }] }`. A fresh `ReceiptView` or `{ authorization: {id,status}, capture: {id,status} }` also works.
- **Settle** (`POST /settle`): the client waits up to 180 s, shows `settle.progress`, then reloads. The response body is not read.
- **Polling without a token**: `/o/:room` polls `GET /api/rooms/:id` every 2.5 s; the fan join screen every 5 s; a receipt every 2.5 s only while a contest is `open|deciding`. Rate limits should allow about 30 requests/min per IP for these GETs.
- **Ledger replay** button shows on rows where `op` matches `/capture/i`, `method === 'POST'` and the status is 2xx; it renders `ReplayResult { captureId, sameAsOriginal, httpStatus? }`.
- **Receipt links on the console**: the results table links `/r/:receiptToken` for each tab when the creator view includes `receiptToken` (useful for the judge checklist). Null it if you would rather not expose it.
- **Nice to have**: `ReviewItem.quoteAtMs` (the review list shows quotes without a timestamp today).
- **Demo hand-off**: the landing page stores `creatorToken` and `stripFans` in `sessionStorage` and opens `/demo/:room`. The console reads `#k=` once, keeps it in `sessionStorage` for that room and removes it from the address bar.
- **Checkout**: v6 `PayPalProvider` with `clientId` from `/api/config`, `components: ['card-fields','paypal-payments']`. Card fields and the PayPal button both rendered against the sandbox SDK (6.68) with the app's client ID. Card path: `POST tab/order {funding:'card'}` -> `submit(orderId)` -> `POST tab/authorize`. PayPal path: button `createOrder` -> approval -> AnswerTab's own "Place $X hold" -> `POST tab/authorize`. A DENIED authorization must come back as `TabView` with `state: 'declined'` (HTTP 2xx), not an error.
- **Connections**: `/demo/:room` holds 4 SSE streams (console + 3 phone iframes). Fine on HTTP/2; on plain HTTP/1.1 (local Vite proxy) Chrome's 6-per-host limit leaves 2 for fetches, so avoid opening a second console tab during local demos.

## Demo agent (src/server/demo, scripts/synthetic.ts), 2026-10-16

All additive; `startDemoRoom`, `setDemoDirector` and `demoTabsReady` keep their signatures.

- **Replay director** (`director.ts`, timeline in `script.ts`): registered by default when `demo/index.ts` loads, so `POST /api/demo` autoplays with no boot wiring. `DEMO_AUTOPLAY=0` turns it off; under Vitest no director runs unless a test installs one (`POST /api/demo` tests still see bots only). `runDirector(ctx, { clock?, script?, log?, beforeStep? })` returns a `DirectorReport` (steps, card states and the states each card went through, drift, notes).
- **`startDemoRoom({ ..., director? })`**: optional per-room director (the synthetic run passes the replay director explicitly). `DemoDirector` now returns `unknown`; **`demoDirectorDone(roomId)`** resolves with the director's result (null when none ran in this process).
- **Progress on existing SSE events only**: `tab.updated` (bot holds), `question.created` / `backing.created` (bots; Ben's near-duplicate uses `checkSimilar` and gets the 409, so nothing is reserved; if intake ever misses it, the card is hidden at once, which releases it), `segment.interim` (replay partial text, via `addSegment({ final: false, source: 'replay' })`, audience all), `segment.added` with `source: 'replay'` (the console's Replay indicator), `verdict` / `question.updated` from the detector, `budget.mode` for manual mode.
- **Timing**: scripted offsets on the room clock (`addSegment(..., scripted: { tStartMs, tEndMs })`); when late, the rest shifts as a block, and every answer segment starts after the last bot action, so no backer is late. Waits use `detectionIdle()` plus the card state, one `triggerDetection()` nudge, and safety timeouts clipped to the 45 s budget. Manual mode (no key, budget hit): the replay still plays and the cards stay open for point-at-span; logged as `[demo] room X: AI is in manual-confirm mode ...`.
- **Synthetic run** (`synthetic.ts`): `runSynthetic(opts?)` -> `{ id, ok, roomId, details }`, written to `synthetic_runs` (checks, PayPal IDs, ledger errors with debug IDs, timings, LLM micros by purpose; no tokens). `startSyntheticScheduler({ everyMin?, firstDelayMs?, log? })` reads `SYNTHETIC_EVERY_MIN` (default off, minimum 5), never overlaps runs, and returns a stop function. Synthetic rooms use `JUDGE_CODE` when set (judge pool, no per-IP room limit).

### Demo agent requests

1. **API owner, `src/server/index.ts`**: call `const stopSynthetic = startSyntheticScheduler()` (from `./demo/synthetic.js`) after `startStatusChecker()`, and `stopSynthetic()` in `shutdown`. Off unless `SYNTHETIC_EVERY_MIN` is set; the burn-in (runbook section 7) depends on it.
2. **API owner, optional new event** (not added): creator-only `{ type: 'demo.progress', step: number, total: number, id: string, label: string, done: boolean }`, so the console can show "Replay 5/8: the answer" instead of inferring it from replay segments. The director would emit it from `runDirector` through `emit(roomId, ..., CREATOR)`.
3. **API owner + web**: the brief's "sandbox degraded" fallback needs the last passed synthetic run's PayPal IDs on the landing page. Suggest `GET /api/demo/last-run` -> `{ finishedAt, roomId, paypal: details.paypal }` from `synthetic_runs WHERE ok ORDER BY finished_at DESC LIMIT 1` (IDs and statuses only; the details hold no tokens).
4. **API owner, budget pools**: synthetic runs bill the judge pool (about $0.04 a run; hourly burn-in is about $1 of the $5 daily pool). If that is too much, a third pool (`ops`, its own daily cap) set on rooms the synthetic run creates would keep judges' budget untouched. Without `JUDGE_CODE`, synthetic rooms are public-pool rooms from IP `synthetic-run` and hit the 20-rooms-a-day limit at the 21st hourly run.
5. **API owner, observation**: a deflected card's `QuestionView.quote` carries the deflection words ("hold that thought."); receipts hide it (approved only), but the fan and overlay views receive it. If the web shows `quote` for any card that has one, a deflection reads like an answer there. Consider nulling `quote` in public views unless the state is locked/approved.
6. **Web owner**: the Replay indicator counts as "playing" for 9 s after a replay segment. Scripted gaps are 7.5-8.5 s, and the director waits for the Opus verifier before the Q2 line, so a slow verifier briefly shows "Replay done — your turn" mid-autoplay. 15 s (or request 2) avoids that.
7. **API owner, failing test**: `test/api.test.ts:292` expects `http://localhost:8787/r/` in note_to_payer, but `config.ts` (changed 14:51) now defaults `PUBLIC_BASE_URL` to `http://localhost:8790`. `npx vitest run` fails on that one assertion until the test or the default changes.

## Integration fixes (main session), 2026-10-16

- Intake `similarTo` from the model is accepted only when content-word Jaccard with the target question is >= 0.15 (`MODEL_SIMILAR_MIN_OVERLAP`). Prevents same-theme, different-question false hints ("folders" vs "tests"). Synonym-only duplicates are not hinted.
- Web `ApiError` carries `details` (extra error fields). The fan ask flow uses `checkSimilar: true` first and offers "Me too" or "Ask anyway" on 409 `similar_question`; intake rejections read `details.reason`.
- Static serving resolves files at request time (`wildcard: true`); missing build assets 404 instead of falling back to index.html. Validation errors return plain-language messages (`bad_link` for bad URL params).
- Icons default to 1em; `.loading-mark` is 28px (the page-loading spinner filled the viewport).
- Console ledger is sorted newest-first at render (snapshot arrives oldest-first).
- Default port is 8790 (8787 is taken on the builder's machine). `PGLITE_DIR` env selects the local PGlite folder.

## Review fixes, server half (src/server, scripts, test, render.yaml, runbook), 2026-10-16

Fixes for docs/review-2026-10-16.md (money F1-F14, judge F1-F3, F6-F8, F11, F17, F18, F26 server parts). All additive unless noted.

**Schema** (`schema.sql`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`): `questions.locked_at_end boolean` (snapshot at End), `tabs.order_attempt integer` (re-order suffix). New job kinds: `auto_end`, `settle_retry` (`jobs.kind` is free text). Job handlers may return `{ again, payload }`; a rescheduled job's `attempts` restarts at 0 (poll counts live in `payload.polls`).

**Behavior changes (contract)**
- End / late verdicts: after End, detector and verifier results never lock; a late lock or verifier agree sends the card to `review` (SSE `verdict` action `review`). Settle charges a `locked` card by default only if it was locked when End was clicked (`locked_at_end`) or the creator pointed its span; otherwise only with an explicit `full`/`half` rating (else `unpaid`). Settle still answers 409 `still_verifying` while a card is `verifying`.
- `ReviewItem` (from `POST /end`, `GET /review`, console `review`) adds `chargedByDefault: boolean`. The web should show `locked` items with `chargedByDefault: false` as needing a rating.
- Receipts (`GET /api/receipts/:token`, verify's `receipt`): each line's `chargeCents` is `null` until the tab is settled (`captured`, `voided`, `failed`), and every line has `status: 'reserved' | 'charged' | 'released' | 'refunded'`. Server type `ReceiptLinePlus`; `src/shared/types.ts` `ReceiptLine.chargeCents` is still `number` (not my path: widen it to `number | null` and add `status` there).
- `GET /api/status` -> `{ checks, lastPassedRun: { id, finishedAt, roomId, steps: [{ name, paypalId, status }], timings } | null }` (newest `synthetic_runs` row with `ok = true`; IDs and statuses only). `synthetic_run` turns `ok: false` ("stale") when the last pass is older than 2x `SYNTHETIC_EVERY_MIN`.
- `POST /api/rooms/:id/settings` `{ language }` (creator; room `draft` or `live`; one of `en-US`, `en-GB`, `en-IN`, `en-AU`, `en-CA`) -> `RoomView`, emits `room.state`. 409 `room_closed`, 400 for other values. `POST /api/rooms` now accepts only the same list (anything else falls back to `en-US`).
- `POST /api/demo`: a non-empty `judgeCode` that does not match -> 403 `bad_judge_code`; no code -> public pool. The response adds `pool`. `room_limit` (429) message now says it is the 20-public-rooms-a-day limit and to use a judge code.
- Console view adds `totals: { grossCents, feeCents, refundedCents, netCents }` (completed captures only, PayPal's own numbers; net = capture nets minus refunds). `TabView.refundedCents` was already populated. `PayoutView` adds `checkedAt` (last time the payout row changed; each poll writes it).
- Settle: `POST /settle` stays idempotent and resumable and always returns `errors[]`. Unknown outcomes leave the room `settling` and schedule `settle_retry` (1 min, backoff to 15 min). Boot schedules it for every room left `settling`. A definitive capture refusal now voids the hold (next `-a{n}` void id): tab `failed`, `authStatus: 'VOIDED'`, `releasedCents` = ceiling.
- Payouts: only a definitive 4xx (not a duplicate) fails an attempt. A lost response or 5xx leaves the row `CREATING` (payout state `pending`) and the next close-contest-window (click or job) resends the same `sender_batch_id`. A capture still `PENDING` holds the payout back: job rechecks every 5 min; the demo control answers 409 `captures_pending`. Captures read back `PARTIALLY_REFUNDED` / `REFUNDED` count as completed everywhere (verify no longer re-books a settled capture). Polling: every 10 s for 90 polls, then every 10 min until 24 h after sending; transient errors no longer end it.
- Contests: one desk at a time per room. Contests left `open`/`deciding` with no live desk in this process (boot, or a desk older than 10 min) move to `failed` so the creator decides; `decide` and close-contest-window trigger that check. Desk writes after a creator decision are ignored.
- Rooms: `auto_end` ends a room still live after 1 h (demo) / 12 h (public); its approve deadline then voids the holds. `expire_room` never deletes a room that still holds money: it ends and voids first, waits until a week after the contest window (finishRoom moves `expires_at` and the job), and waits while a payout or contest is pending.
- Tabs: `POST /tab/order` with a different `ceilingCents` or `funding` while the tab is `opening` without an authorization updates the tab and creates a new order (`order-...-a{n}`); authorize then uses `order_attempt` in its suffix too. The old order id gets 400 `wrong_order`.
- LLM budget: `callClaude` reserves `max(estMicros, max_tokens x output price)` atomically against the pool and the room (conditional UPDATEs) before calling, then corrects to the real cost (`budget.reserve`, `budget.settleReservation`). Near the cap, an Opus desk turn (16k max tokens, $0.32 reserve) is refused earlier than before.
- Webhooks: `verifyWebhookResult()` (new export; `verifyWebhook()` keeps its boolean contract) checks the cert URL (https, PayPal API host) and a transmission time within 24 h before calling PayPal, uses its own 1-slot limiter (queue over 8 -> unknown), and keeps the event body out of the ledger. `unknown` (timeout, 5xx, no status) -> route answers 503 `verify_unavailable` so PayPal redelivers. Unverified events store only `{ id, event_type }`; a later verified delivery stores the full scrubbed body. Test fake: `webhookVerifies: boolean | 'unknown'`.
- SSE: creator streams have their own cap (20 per room) and are always admitted when viewers fill the room; max 6 streams per fan token and 40 per IP per room (429 `too_many_streams`); the events route rate limit is keyed by IP alone (120/min).
- Logs: `redactUrl` masks `token=`, `k=`, `t=` (any case), receipt paths and `/r/`. No other log line carries a token.
- Ops: `src/server/index.ts` starts `startSyntheticScheduler()` after the status checker and stops it on shutdown (off unless `SYNTHETIC_EVERY_MIN` is set; `render.yaml` sets 60; `.env.example` documents it, empty locally).

**For the web half**
- Settle UI: refetch `/review` (or use `chargedByDefault`) after End; send explicit ratings for locked cards with `chargedByDefault: false`; read `errors[]`; show Retry when `room.status === 'settling'`.
- Receipt UI: handle `chargeCents: null` and use `status`.
- The SSE aliases `k=`/`t=` are not needed (the server reads only `token`); `?lite=1` is not implemented.
- Not done on the server: judge F25 (per-backing late/eligible flag) and the `demo.progress` event.

## Review fixes, web half (src/web, test/web-fixes.test.ts), 2026-10-16

Fixes for docs/review-2026-10-16.md judge F2 (client), F4, F5, F6 (client), F9, F10, F12-F17, F19-F25. No server or shared-type changes; every new field is read defensively, so older bodies still render.

**What the web now sends or reads**
- SSE URL is `/api/rooms/:id/events?token=TOKEN&role=creator|fan`: the `k=`/`t=` aliases are gone.
- `POST /api/rooms/:id/settings { language }` from a "Speech language" select in the console mic panel (room `draft` or `live`). Offers exactly the server's list: `en-US`, `en-GB`, `en-IN`, `en-AU`, `en-CA`.
- `POST /settle` body is read: `room.status` and `errors[]` (`{ tabId, message }`). Success toast only when the room is `settled` or `voided`. A room left `settling` with nothing in flight shows the errors and **Retry settlement** (re-posts the same ratings). `still_verifying` (409) keeps the server's message and refetches the review list.
- Review list: kept current from live `question.updated` events after End (`liveReview` in `lib/review.ts`) plus a debounced `GET /review` refetch. `verifying` cards are shown as pending and Settle stays disabled until none is left. `chargedByDefault: false` locks start unrated (charged only if the creator picks Full/Half).
- `POST /close-contest-window` reads `{ payout }`; "Payout sent" only when it is non-null.
- `POST /api/receipts/:token/verify` reads `checkedAt`, `matches`, `mismatches[]`: green only when `matches` is true and there are no mismatches; otherwise a warning listing them. `amountCents` (authorization) and `grossCents` (capture) are shown per record.
- Receipt lines: `chargeCents: null` or `status: 'reserved'` (or, on older servers, an unsettled tab while the room is live/ended/settling) reads "Reserved — decided when the creator settles". `disputeOpen` shows a banner and hides "I wasn't answered".
- Console `disputes` (DisputeView) get a **Disputes** tab in the money panel (and the presentation's "Contests & payout" pane when any exist): status, reason, amount, fan, respond-by date, PayPal IDs, each line's quote and charge, contest history, raw JSON and **Download JSON**.
- Console `totals` drives Results Net and the recap (refunds subtracted); without it the client computes gross - fees - refunds. A `contest.updated` with state `refunded` reloads the console snapshot (no `tab.updated` arrives for the refund).
- `GET /api/status` `lastPassedRun.steps[]` (`{ name, paypalId, status }`) render as a "Recorded run" box on the landing page and a collapsible one on `/demo/:room`, only while a `paypal_*` check other than `paypal_webhook` fails. Landing shows plain check names instead of internal ones.
- `POST /api/demo` 403 `bad_judge_code` and 429 `room_limit` show their own copy (server message kept for `room_limit`). If a code was typed but `pool` comes back `public`, the presentation toasts that the code was not recognized.

**Presentation layout (`/demo/:room`)**
- One SSE connection: the page relays each event to the phone iframes with `postMessage` (target origin = own origin), filtered per fan like the server's audiences (`lib/relay.ts`: own `tab.updated` only, hidden cards redacted, no ledger/verdict/payout/contest). Phones load with `?embed=1&relay=1`, open no EventSource, accept only messages whose `origin` is their own and whose `source` is `window.parent`, and still do their own `/me` reloads. A parent stream reconnect sends `resync` to every phone.
- `?scale=` is no longer forwarded to the phones (it clipped them at 130%/150%).
- "Try it yourself" button and drawer over the strip: fan link, QR, open-in-new-tab, the judge checklist, Full console link. Opens once when the replay hands over; `?record=1` (or "Hide for recording") removes the button and drawer.
- After End the transcript folds to one bar, and the review's approve/settle bar is sticky at the bottom of the stage pane.
- Replay indicator is derived from data (`lib/replay.ts`): bots placing holds -> replay starting -> "Replay n/3 (playing)" from `source: 'replay'` segments and replay interims -> "Claude is checking" while a card is `verifying` -> "Replay done — your turn"; "Replay finished" once the room is not live. `REPLAY_LINES = 3` mirrors `DEMO_SCRIPT`'s three `say` steps: keep them in step.

**Other UI**
- Fan cards: a backing with `chargeable: false`, `late: true`, or `backedAtMs > quoteAtMs` reads "Joined after the answer — not charged" and never triggers the lock moment. The server sends none of these today (judge F25 server part), so this only takes effect once `BackingView` carries one of them.
- Keyboard: the transcript is focusable when pointing is possible; arrows move a word caret, Shift+arrows extend, Home/End jump, Enter attaches, Esc cancels. Space push-to-talk only fires when focus is on the talk button or on no control (never on buttons, tabs, links or fields).
- Dark-mode LIVE badge and talk button use `--c-live-solid` (#d93a2f, 4.6:1 with white); `--c-live` (text) is unchanged. Fan header logo no longer shrinks.
- Landing timing copy matches a measured run (holds about 4 s, first replay words about 17 s after the click, done about 36 s).

**Requests for the server half**
- Judge F25: add `backedAtMs` (room clock) or `chargeable: boolean` to `BackingView` in `/me`, so a late backer's phone stops saying "$3 locked".
- Emit `tab.updated` (creator and that fan) after a contest refund, so `refundedCents` updates without a snapshot reload.
- `src/shared/types.ts` (not my path): `ReceiptLine.chargeCents: number | null` plus `status`, `ReviewItem.chargedByDefault?`, `ConsoleView.disputes/totals`. The web uses local extended types until then.

## Polish, role: web (src/web, test/web*.test.ts), 2026-10-16

Items P3, P4 (web half), P13 (checklist half), P16 (web half), P18 (web half) of the polish plan. No server or shared-type edits; every new field is read defensively and hidden when absent or null.

**What the web now reads**
- `TabView.captureWebhookAt` (receipt): "Confirmed by PayPal webhook, 12 s ago" badge (icon `webhook`) next to the capture ID. While the tab is `captured` and the field is present but `null`, the receipt re-reads `GET /api/receipts/:token` every 10 s for up to 3 min so the badge appears without a reload; an absent field (older server) never polls. Nothing waits on it.
- `ContestView.refundWebhookAt` (receipt and console contest cards): the same badge under the refund ID.
- `ConsoleView.webhooks`: a "PayPal webhooks" box at the top of the PayPal ledger panel (console and presentation): event type, resource ID, relative time, newest first, only entries with `verified: true` and an id, type and time. Field absent or null: no box; empty array: "No verified events yet".
- `QuestionView` / `ReviewItem` / `ReceiptLine` `.quoteTruncated`: only an explicit `true` adds a muted ellipsis after the highlighted words (the quote text itself is unchanged; screen readers hear "the answer continues past this quote"). `liveReview` carries the live question's flag. Receipt chip for a half-charged line now reads "Partial answer, half".

**Landing (P3, P16)**
- Banner and recorded run only for judge-affecting failures (`judgeAffecting`: `paypal_oauth`, `paypal_balance`, `anthropic`, `llm_budget_judge`, `llm_budget_public`). `paypal_webhook` and `synthetic_run` stay on `/status`. The recorded run also shows for a Claude or budget failure, with its own wording (`RecordedRun cause="claude"`). Header pill: "All checks passing" only when every check passes, otherwise a neutral "Status" link. `paypalDegraded` and `Demo.tsx` unchanged.
- `/?code=JUDGE_CODE` prefills the judge-code field (shown, not focused) so one click on "Start a demo room" sends it; the code is then removed from the address bar (router `replace`). `bad_judge_code` copy unchanged. New line under the CTA: "No login or keys needed; the judge code in the Devpost instructions reserves extra Claude budget."

**Checklist (P13)**: nine items. New manual items last: "Try to trick it" and "See a declined card". The decline item also ticks itself when a non-bot tab is `declined`.

**Request for the server half**: the request log line for `GET /?code=...` carries the judge code in clear (checked on a local run). Please add `code=` to `redactUrl`'s masked params.

## Polish: server-ai-ops (src/server, src/shared/types.ts, scripts, eval, test, workflows, runbook), 2026-10-16

All additive and optional; older clients ignore the new fields. Money rules, guard, detector prompt, τ and the demo script are unchanged.

**Schema** (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`): `tabs.capture_webhook_at timestamptz`, `contests.refund_webhook_at timestamptz`, `questions.quote_truncated boolean NOT NULL DEFAULT false`, index `webhook_events_resource` on `webhook_events(resource_id)`.

**Shared types** (`src/shared/types.ts`)
- `TabView.captureWebhookAt?: string | null` (so also `ReceiptView.tab` and `tab.updated`): the first verified `PAYMENT.CAPTURE.*` webhook whose capture status is completed (`COMPLETED`, `PARTIALLY_REFUNDED`, `REFUNDED`) and whose capture id is the tab's. Pending/declined capture events never set it. Setting it emits `tab.updated` (creator and that fan). Later deliveries keep the first time.
- `ContestView.refundWebhookAt?: string | null`: the first verified `PAYMENT.CAPTURE.REFUNDED` with status `COMPLETED` for the contest's `refund_id`; emits `contest.updated`. If the event lands before the refund call returns, `issueRefund` back-fills it from the stored event.
- `ConsoleView.webhooks?: WebhookEventView[]` (`{ id, eventType, resourceId, receivedAt, verified }`): verified events whose `resource_id` is one of the room's capture, authorization, refund, payout batch or dispute ids (or whose `resource.payout_batch_id` is the room's batch, for `PAYMENT.PAYOUTS-ITEM.*`), newest first, at most 50. Unverified events are never listed. Snapshot only (no SSE event); the console sees new rows on its next reload.
- `QuestionView.quoteTruncated?`, `ReviewItem.quoteTruncated?`, `ReceiptLine.quoteTruncated?: boolean`: the stored span ends before the last word of its end segment (after the guard's 1-2 word snap). Set wherever the guard result is stored (`writeEvidence` in `domain/detection.ts`, also for deflections) and in `pointSpan`; cleared by undo. False whenever `quote` is null; on receipts only for approved lines (same rule as `quote`). Helper: `quoteTruncated(span, window)` exported from `domain/detection.ts`.

**Env**: `ROOMS_PER_IP_PER_DAY` (default 20, positive integer; anything else falls back to 20), read on every room creation by `roomsPerIpPerDay()` (exported from `domain/index.ts`; `ROOMS_PER_IP_PER_DAY` const kept as the default). The `room_limit` message quotes the live value. In `render.yaml` (20) and `.env.example`; judging-window values in runbook section 9.

**Demo director** (`src/server/demo/director.ts`): `DirectorStepResult` adds, for `say` steps, `reachedAtMs` (room clock when the director first saw the card in an expected state; polled, so an upper bound; null if never) and `replayToStateMs` (`reachedAtMs - atMs`). The synthetic run stores them per step in `details.director.steps[]` plus `details.director.replayToLockMs` (Q1 answer, null unless locked); `replayToLock(report)` is exported from `synthetic.ts`. First real run: 4.5 s replay-to-lock (Opus verifier included).

**Eval runner** (`scripts/eval.ts`): `--category` already existed (per split); `--split all` (needs `--category` and `--allow-test`) runs one category across every split. Summaries add `metrics.runsAllCorrect` (`{ runs, answeredLocked, deflectionsShown, partialsToReview }`: runs where every pair of that kind was right) and `metrics.pairTotals`. Results in `docs/eval-results.md`: the held-out test split **missed** the 0-false-charge target (1/27 in run 4, `test-sarcasm-1`, confidence exactly 0.80); the demo-lines soak passed 30/30.

**Ops**: `.github/workflows/live-smoke.yml` (30-minute cron + manual run with `force_failure`; repository variable `DEMO_URL`; fails on a judge-affecting check that is not ok, missing or stale). Runbook sections 9 (judging window) and 10 (live smoke), and a soak-table query in section 7.

**For the web half**
- Receipt badge: show it when `tab.captureWebhookAt` is set; a contest's refund badge from `contest.refundWebhookAt`. Nothing should wait on either.
- Console "PayPal webhooks" list: `ConsoleView.webhooks` (already newest first).
- Ellipsis: `quoteTruncated` on `QuestionView`, `ReviewItem` and `ReceiptLine`.
- Not in my paths: the README "held-out test (synthetic)" column (numbers are in `docs/eval-results.md`: worst-run false charges 1/27 = 0.037, Wilson 95% 0.007 to 0.183; mean recall 0.994; review rate 0; p95 1877 ms).

## Polish, role: docs-visuals (README, docs, scripts/capture.ts, docs/img), 2026-10-16

Items P10 (images), P11 (README accuracy), P13 (docs half), plus the P14/P16 doc updates. No source, schema, shared-type, money, guard, prompt, τ or demo-script change; nothing here changes runtime behavior.

- **New devDependency** `puppeteer-core` 25.12.0 (exact). It drives the installed Chrome (`CHROME_PATH`, default the macOS app); it downloads no browser.
- **`scripts/capture.ts`** (type-checked by `tsconfig.scripts.json`): `BASE_URL=http://localhost:8799 npx tsx scripts/capture.ts` against a running build. Env: `BASE_URL` (default `http://localhost:8799`), `CHROME_PATH`, `JUDGE_CODE` (optional; opens `/?code=` so the room uses the judge pool), `OUT_DIR` (default `docs/img`). Needs `ffmpeg` on PATH. It clicks through the real UI: landing → Start a demo room → autoplay (frames recorded while Q1 goes deflected → verifying → locked) → End, rate Q2 Half, settle → full console with Replay to PayPal → Chen's receipt with Verify → contest Q2 → Close contest window (demo). It reads the creator token from the tab's `sessionStorage` (`answertab:creator:<room>`, `answertab:demo:<room>`, as `src/web/lib/session.ts` writes them) and polls `GET /api/rooms/:id/console` for states. It fails rather than saving a misleading image when the room is in manual mode, Q1 goes to review, the contest is not refunded, or any PNG stays over 500 KB after a 256-colour re-encode. One run is one demo room: $0.01 to $0.03 of Claude per full run in local runs, plus sandbox calls.
- **It depends on these UI strings and selectors** (change them and the script needs the same change): `form.hero__cta button[type=submit]`, "End stream", "End and review", `.review__item`, `[role=radiogroup][aria-label="Rating for question 2"]` with a "Half" radio, "Approve all and settle", "Replay to PayPal", "Same capture ID", "Verify with PayPal", `.verify__out`, `li.rline` with "#2", a button containing "answered", `form.contestform textarea`, "Send contest", "Refunded", "Contests & payout", "Close contest window (demo)", `.demo__stagebody`, the "Close the checklist" aria-label, and fan-phone iframes whose URL contains `/f/` and whose text contains "locked" after a lock.
- **Images** in `docs/img/`: `three-phone-lock.gif` (1280 px, about 5 s, real-time frame durations, palettegen/paletteuse), `presentation-lock.png`, `review.png`, `results-ledger.png`, `receipt-verify.png`, `contest-refunded.png`, `payout.png` (all 1280 px wide, under 500 KB), `fan-phone.png` (390 px CSS at 2x), and a hand-drawn `architecture.svg` (text and boxes only, light and dark palettes via `prefers-color-scheme`, opaque background). The committed set is from a local build (room `xA5Laniui1`); re-capture on the hosted build after the Nov 6 freeze (checklist item 13).
- **Docs**: README (GIF and rule above "The problem", image strip under "How it works", SVG under "Architecture", criteria map with a "See it" column, "Unhappy paths you can trigger", "Threat model", authorization windows with the PayPal guide cited, held-out eval column, rewritten related work), new `docs/real-money.md`, and updates to `docs/devpost-submission.md` (judge link with `?code=`, gallery list, held-out numbers), `docs/video-script.md` (cold open on the lock, real-phone beat with the injection, 2-second decline and injection captions) and `docs/submission-checklist.md` (dated builder items in plan order).
