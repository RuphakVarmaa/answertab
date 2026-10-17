# What a real-money AnswerTab would need

This build runs on the PayPal sandbox only: the server refuses to start unless `PAYPAL_ENVIRONMENT` is `sandbox` ([src/server/config.ts](../src/server/config.ts)). This page lists what has to change, or be agreed with PayPal and with creators, before any real money moves. None of it is built. PayPal pages cited here were checked on 2026-10-16.

## 1. Who the merchant is

In this build AnswerTab is the merchant of record. Fans' authorizations and captures are AnswerTab's, AnswerTab keeps a platform fee, and the creator is paid afterwards with PayPal Payouts ([src/server/domain/payouts.ts](../src/server/domain/payouts.ts)).

A production version should instead be a platform in PayPal's multiparty model, where the creator is the seller and AnswerTab takes a partner fee on each transaction. PayPal's [multiparty overview](https://developer.paypal.com/docs/multiparty/) describes partner fees as per-transaction commissions and says live credentials come only after PayPal has approved the platform or marketplace. That means:

- an application to PayPal and approval of the model before going live;
- each creator onboarded through PayPal as a seller (the page describes seller onboarding under local regulations and compliance rules);
- captures paid to the creator with AnswerTab's fee taken as a partner fee, so the Payouts step and its timing go away;
- the same one-capture-per-fan settlement, request IDs and ledger, pointed at the creator as payee.

## 2. Disputes after the payout

A fan can still dispute a capture with PayPal after the contest window has closed and the creator has been paid. In this build that dispute lands on AnswerTab, which has already paid the creator. A real launch needs a creator agreement that covers it: how a lost dispute is recovered from the creator, or a reserve held back from payouts until disputes are unlikely. Under the multiparty model the dispute lands on the creator as the seller, and AnswerTab supplies the evidence.

The evidence pack already exists: on `CUSTOMER.DISPUTE.*` webhooks the console shows the case with the question, the quote, its timestamps, the capture ID and the contest history as JSON ([src/server/domain/disputes.ts](../src/server/domain/disputes.ts)). Submitting that evidence to PayPal through the Disputes API is not implemented, and the path has not been run against a real sandbox dispute yet.

## 3. Seller protection

Sandbox captures for these charges report `seller_protection.status: NOT_ELIGIBLE` (for example [test/fixtures/paypal/A_cap7.json](../test/fixtures/paypal/A_cap7.json)). An answered question is an intangible service with no shipment to track, so a creator should not count on seller protection. The protection AnswerTab offers is evidence: a quote cut from the creator's own words, the creator's approval, the receipt the fan saw, and the contest record.

## 4. Payouts availability

Payouts has to be enabled on the sending account, and not every merchant country can send. The default sandbox accounts for this project were India-based, and an India-based merchant got `PAYOUT_NOT_AVAILABLE`, so the project uses a US merchant ([docs/sandbox-capabilities.md](sandbox-capabilities.md)). PayPal's [Payouts overview](https://developer.paypal.com/docs/payouts/) lists the countries Standard Payouts can send to; a launch has to check the sending side for the platform's own country. Under the multiparty model in section 1, Payouts is no longer needed to pay creators.

## 5. Card fields and PCI scope

Fans type the card number, expiry and CVV into PayPal's JS SDK v6 card fields ([src/web/pages/fan/Checkout.tsx](../src/web/pages/fan/Checkout.tsx)). The server creates the order without a `payment_source`, the browser attaches the card, and the server then authorizes, so AnswerTab's server never receives card data. The ledger also strips card data from every stored PayPal response ([src/server/paypal/redact.ts](../src/server/paypal/redact.ts)). A production merchant still has to complete its own PCI DSS self-assessment; which questionnaire applies to this integration should be confirmed with PayPal and the acquirer, not assumed. PayPal's [Expanded Checkout page](https://developer.paypal.com/docs/checkout/advanced/) lists which countries and currencies card payments are available in.

## 6. Authorization windows

Nothing changes here. PayPal's [authorization guide](https://developer.paypal.com/docs/checkout/standard/customize/authorization/) gives 29 days of validity and a 3-day honor period, and the room windows in [src/server/domain/clock.ts](../src/server/domain/clock.ts) capture or void every hold from a live public room within 36 hours. Holds placed while a room is still a draft are the exception: a room that never starts, and is not ended by its creator, is voided when it expires after 7 days. A launch should either block tabs until the room is live or void draft-room holds sooner. The README section "Why the money is safe" has the details.

## 7. Sandbox-only pieces to remove or gate

- Bot fans place holds server-side with PayPal's published sandbox test cards ([src/server/paypal/testCards.ts](../src/server/paypal/testCards.ts)). That is only possible in the sandbox and must not exist in production.
- The demo controls (demo rooms, "Close contest window (demo)", the judge code) are for judging.
- Sandbox fees follow the sandbox schedule. Production fees come from PayPal's responses the same way, but the price screen's published-rate estimates ([src/web/lib/fees.ts](../src/web/lib/fees.ts)) need checking against the live rates for each market.
- Credentials: a new live REST app, a new webhook, and keys kept out of the repository, as the runbook describes for the sandbox ([docs/runbook.md](runbook.md)).
