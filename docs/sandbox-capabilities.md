# PayPal sandbox capabilities (verified 2026-10-16)

Sandbox REST app `agent-hack-us`, merchant country US. Each row was checked with a real sandbox call.

| Capability | Endpoint | Result |
|---|---|---|
| OAuth client credentials | `POST /v1/oauth2/token` | 33 scopes |
| Orders (PayPal wallet) | `POST /v2/checkout/orders` | `CREATED`, buyer approval link returned |
| Card capture, no buyer login | `POST /v2/checkout/orders` with `payment_source.card` (test card 4111111111111111) | `COMPLETED` in one call |
| Payouts | `POST /v1/payments/payouts` | batch `PENDING` |
| Invoicing v2 | `POST /v2/invoicing/generate-next-invoice-number`, `POST /v2/invoicing/invoices` | OK |
| Transaction Search | `GET /v1/reporting/transactions` | OK |
| Balances | `GET /v1/reporting/balances` | USD 5000.00 |
| Vault v3 | `POST /v3/vault/setup-tokens` | `PAYER_ACTION_REQUIRED` + approve link |
| Catalog products (Subscriptions) | `POST /v1/catalogs/products` | OK |
| Disputes | `GET /v1/customer/disputes` | OK (empty) |

Notes
- The default sandbox accounts were India-based. An IN merchant gets `PAYOUT_NOT_AVAILABLE` on Payouts, so the project uses a US merchant.
- Test personas: US business `sb-uycio53304181@business.example.com`, US buyer `sb-uvsx753392150@personal.example.com`.
- After enabling a feature in the dashboard, terminate the cached token (`POST /v1/oauth2/token/terminate`) or the new scopes won't appear until it expires.
- Sandbox app names cannot contain the word "paypal".

## PayPal module checks (2026-10-16, src/server/paypal)

Run through the module itself: `test/paypal.sandbox.test.ts` (room `itMojwFKUL`) and `npm run sandbox:proof` (run `L8y5vV`, 20/20 steps, 43 calls; full table in `docs/sandbox-proof.md`).

| Check | Result | Evidence (debug id) |
|---|---|---|
| bot_card AUTHORIZE through Server SDK 2.5.0 | 201, order `COMPLETED`, auth `CREATED`, 29-day expiry | order 5H484705A64509234 (ca4b59fd84ca2) |
| Rotated test cards: Visa 4111…1111, Mastercard 5555…4444, Amex 3714…8431, Discover 6011…1117 | all `CREATED`, then `VOIDED`; 4 in parallel through the limiter | proof step 1 |
| Cardholder `CCREJECT-REFUSED` | 201, order `COMPLETED`, auth `DENIED`, processor `0500` | order 7FB36410VW5193304 (ca4b5a01f9d88) |
| Card-fields path: order without payment_source + `application_context` (brand, NO_SHIPPING, CONTINUE), then confirm-payment-source with a card, then `authorizeOrder` | `CREATED` -> `APPROVED` -> auth `CREATED` | order 4HM0053164626273R (ca4b5a03ace3e) |
| Wallet order with `payment_source.paypal.experience_context` | **HTTP 200** (not 201), `PAYER_ACTION_REQUIRED`, payer-action link | order 45E67558591071613 (ca4b5a0534de0) |
| Capture reusing the order's `invoice_id` (`tab-{room}-{fan}`) | accepted; no DUPLICATE_INVOICE_ID | capture 9DP2030183371883J (ca4b59fe82a2a) |
| One partial capture with `final_capture: true` | `COMPLETED`, auth `CAPTURED`; $7.00 fee $0.67 net $6.33 | as above |
| Replay capture with the same PayPal-Request-Id | **HTTP 200**, same capture id | ca4b59ffbd94f |
| Capture after the final capture (`-a1`) | 422 `AUTHORIZATION_ALREADY_CAPTURED` | ca4b5a0012b55 |
| `PayPal-Mock-Response` `AUTHORIZATION_EXPIRED`, then a real retry as `-a1` | 422, then 201 `COMPLETED` | ca4b5a045e99d, ca4b5a047fa53 |
| Agent Toolkit 1.11.0 `create_refund`, partial, explicit amount | **works**: 201 `COMPLETED`. PayPal accepts `capture_id` in the body, so no Server SDK fallback was needed (ledger op `refunds.create:toolkit`). The response is minimal (no Prefer header) | refund 01X78775LG7323300 (ea28541168788) |
| Toolkit `create_refund` replay, same `refund-{contest}` request id | HTTP 200, same refund id | b52c7e47df314 |
| Toolkit `get_refund` | `seller_payable_breakdown`: $3.00 gross, fee returned $0.00, net $3.00 | 718285dc637f8 |
| Toolkit `get_order` (used for `getOrder`) | auth `CAPTURED`, capture listed | 543c4c867f4d6 |
| Toolkit `get_dispute` on an unknown id | 404 `RESOURCE_NOT_FOUND`, mapped to PayPalError | f738cf9548912 |
| Toolkit OAuth | each fresh instance fetches its own token (+0.3–1.2 s per action); ledger op `toolkit.oauth.token` | proof steps 13–16 |
| Payout $1 to the US sandbox buyer | 201 batch `PENDING`, item `PENDING`, fees not reported yet | batch RVH4PCJL3VCZU (ca4b5a0909f72) |
| Payout reusing `sender_batch_id` | **rejected, not replayed**, even with the same PayPal-Request-Id: 400 `USER_BUSINESS_ERROR`, details[0] field `SENDER_BATCH_ID`, issue "Batch with given sender_batch_id already exists". Top-level `links` is empty; the original batch is linked under `details[0].link[0].href` | ca4b5a09e2e8c |
| Reporting balances | USD 5001.18 (unchanged across the runs: balances lag) | ca4b5a0a40d09 |
| Webhooks list | 0 webhooks registered on this app | ca4b5a0a68820 |

Latency (this run): orders.create 0.6–4.1 s (card orders 2.4–4.1 s), capture 1.8–1.9 s, void 0.8–1.5 s, GETs 0.4–1.4 s, toolkit refund 0.6–1.5 s plus its token fetch.
