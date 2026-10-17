// Re-runnable PayPal sandbox proof. Uses src/server/paypal exactly as the app does, with a fresh run id and an
// in-memory ledger, then writes docs/sandbox-proof.md (steps, statuses, debug ids, latencies; no secrets) and the
// redacted ledger to scripts/sandbox-proof/out/<run>.json.
//   npm run sandbox:proof
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { config } from '../../src/server/config.js'
import { openDb, setDb } from '../../src/server/db/db.js'
import { base58 } from '../../src/server/ids.js'
import { sdkCall } from '../../src/server/paypal/client.js'
import * as pp from '../../src/server/paypal/index.js'
import type { LedgerCallView } from '../../src/shared/types.js'

interface StepResult {
  n: number
  label: string
  expected: string
  ok: boolean
  detail: string
  ms: number
}

const runId = base58(6)
const roomId = `proof${runId}`
const steps: StepResult[] = []
const calls: { step: number; call: LedgerCallView }[] = []
let current = 0

pp.onLedgerCall(({ call }) => calls.push({ step: current, call }))

function fanId(tag: string) {
  return `fan_${tag}${base58(4)}`
}

async function step(label: string, expected: string, fn: () => Promise<{ ok: boolean; detail: string }>): Promise<void> {
  current = steps.length + 1
  const started = performance.now()
  let r: { ok: boolean; detail: string }
  try {
    r = await fn()
  } catch (e) {
    const err = pp.toPayPalError(e)
    r = { ok: false, detail: `threw ${err.name}${err.issue ? `/${err.issue}` : ''} (HTTP ${err.httpStatus}, debug ${err.debugId ?? '-'})` }
  }
  steps.push({ n: current, label, expected, ok: r.ok, detail: r.detail, ms: Math.round(performance.now() - started) })
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${current}. ${label}: ${r.detail}`)
}

/** Runs fn expecting a PayPalError with this issue. */
async function expectIssue(fn: () => Promise<unknown>, issue: string): Promise<{ ok: boolean; detail: string }> {
  try {
    await fn()
    return { ok: false, detail: `expected ${issue}, call succeeded` }
  } catch (e) {
    const err = pp.toPayPalError(e)
    return { ok: err.issue === issue, detail: `HTTP ${err.httpStatus} ${err.name}/${err.issue} (debug ${err.debugId ?? '-'})` }
  }
}

async function main() {
  const cfg = config()
  const db = await openDb({ databaseUrl: null, pgliteDir: 'memory' })
  setDb(db)
  await db.query(`INSERT INTO rooms (id, creator_token_hash, title, kind, pool, question_price_cents, metoo_price_cents) VALUES ($1, 'proof', 'Sandbox proof', 'demo', 'judge', 300, 100)`, [roomId])
  const startedAt = new Date()

  const fans = { A: fanId('A'), B: fanId('B'), C: fanId('C'), D: fanId('D'), E: fanId('E') }
  for (const f of Object.values(fans)) {
    await db.query(`INSERT INTO fans (id, room_id, display_name, fan_token, is_bot) VALUES ($1, $2, $1, $3, true)`, [f, roomId, `tok-${f}`])
    await db.query(`INSERT INTO tabs (id, room_id, fan_id, ceiling_cents, funding) VALUES ($1, $2, $3, 2000, 'bot_card')`, [`tab_${f}`, roomId, f])
  }
  const s: Record<string, string> = {}

  await step('Test cards in parallel (limiter max 4)', `each of ${pp.TEST_CARDS.length} cards: auth CREATED, then VOIDED`, async () => {
    const out = await Promise.all(
      pp.TEST_CARDS.map(async (card, i) => {
        const f = fanId(`card${i}`)
        const o = await pp.createAuthorizeOrder({ roomId, fanId: f, ceilingCents: 100 + i, funding: 'bot_card', botCard: card })
        const v = o.authStatus === 'CREATED' ? await pp.voidTab({ roomId, fanId: f, authorizationId: o.authorizationId! }) : { status: '-' }
        return { card: card.label, ok: o.authStatus === 'CREATED' && v.status === 'VOIDED', text: `${card.label} ${o.authStatus}/${v.status}` }
      }),
    )
    return { ok: out.every((x) => x.ok), detail: out.map((x) => x.text).join(', ') }
  })

  await step('Tab A: bot_card AUTHORIZE $20', 'HTTP 201, order COMPLETED, auth CREATED', async () => {
    const o = await pp.createAuthorizeOrder({ roomId, fanId: fans.A, ceilingCents: 2000, funding: 'bot_card', botCard: pp.botCard(0) })
    s.orderA = o.orderId
    s.authA = o.authorizationId ?? ''
    return { ok: o.status === 'COMPLETED' && o.authStatus === 'CREATED', detail: `order ${o.orderId} ${o.status}, auth ${o.authorizationId} ${o.authStatus}, expires ${o.expiresAt}` }
  })

  await step('Tab A: settle with one $7 capture (final_capture)', 'COMPLETED, fee and net from seller_receivable_breakdown', async () => {
    const c = await pp.captureTab({ roomId, fanId: fans.A, authorizationId: s.authA!, amountCents: 700, noteToPayer: 'AnswerTab: Q1 answered on stream (proof run).' })
    s.captureA = c.captureId
    s.captureCallA = c.ledgerCallId
    return { ok: c.status === 'COMPLETED' && c.finalCapture === true && c.netCents === c.grossCents - (c.feeCents ?? -1), detail: `capture ${c.captureId} ${c.status}, gross ${c.grossCents}c fee ${c.feeCents}c net ${c.netCents}c` }
  })

  await step('Tab A: GET capture and authorization', 'capture COMPLETED, authorization CAPTURED (rest released)', async () => {
    const c = await pp.getCapture(s.captureA!, { roomId, fanId: fans.A })
    const a = await pp.getAuthorization(s.authA!, { roomId, fanId: fans.A })
    return { ok: c.status === 'COMPLETED' && a.status === 'CAPTURED', detail: `capture ${c.status}, authorization ${a.status}` }
  })

  await step('Tab A: replay the capture with the same PayPal-Request-Id', 'same capture id, no second charge', async () => {
    const r = await pp.replayCapture(s.captureCallA!)
    return { ok: r.sameAsOriginal, detail: `HTTP ${r.httpStatus}, capture ${r.captureId}, same as original: ${r.sameAsOriginal}` }
  })

  await step('Tab A: capture again after the final capture (attempt 1)', '422 AUTHORIZATION_ALREADY_CAPTURED', () =>
    expectIssue(() => pp.captureTab({ roomId, fanId: fans.A, authorizationId: s.authA!, amountCents: 100, noteToPayer: 'again', attempt: 1 }), 'AUTHORIZATION_ALREADY_CAPTURED'),
  )

  await step('Tab B: AUTHORIZE $10, nothing answered, void', 'auth CREATED, then VOIDED', async () => {
    const o = await pp.createAuthorizeOrder({ roomId, fanId: fans.B, ceilingCents: 1000, funding: 'bot_card', botCard: pp.botCard(1) })
    const v = await pp.voidTab({ roomId, fanId: fans.B, authorizationId: o.authorizationId! })
    const a = await pp.getAuthorization(o.authorizationId!, { roomId, fanId: fans.B })
    return { ok: v.status === 'VOIDED' && a.status === 'VOIDED', detail: `auth ${o.authorizationId} ${o.authStatus} -> void ${v.status}, GET ${a.status}` }
  })

  await step(`Tab C: cardholder ${pp.DECLINE_NAME}`, 'HTTP 201, order COMPLETED, auth DENIED (processor 0500)', async () => {
    const o = await pp.createAuthorizeOrder({ roomId, fanId: fans.C, ceilingCents: 1000, funding: 'bot_card', botCard: pp.declineCard() })
    return { ok: o.status === 'COMPLETED' && o.authStatus === 'DENIED', detail: `order ${o.orderId} ${o.status}, auth ${o.authorizationId} ${o.authStatus}, processor ${o.processorResponse?.responseCode}` }
  })

  await step('Tab D: card-fields path (create, confirm card, authorizeOrder)', 'order CREATED, confirm APPROVED, auth CREATED', async () => {
    const o = await pp.createAuthorizeOrder({ roomId, fanId: fans.D, ceilingCents: 2000, funding: 'card' })
    // In the app the browser's card fields do this confirm step; here it stands in for them.
    const card = pp.TEST_CARDS[0]!
    const conf = await sdkCall(
      { op: 'proof.orders.confirm', method: 'POST', endpoint: `/v2/checkout/orders/${o.orderId}/confirm-payment-source`, ctx: { roomId, fanId: fans.D } },
      (c) =>
        c.orders.confirmOrder({
          id: o.orderId,
          prefer: 'return=representation',
          body: { paymentSource: { card: { name: 'Proof Card', number: card.number, expiry: card.expiry, securityCode: card.securityCode, billingAddress: { ...card.billingAddress } } } },
        }),
    )
    const a = await pp.authorizeOrder({ roomId, fanId: fans.D, orderId: o.orderId })
    s.authD = a.authorizationId
    const confirmStatus = String((conf.body as { status?: string }).status)
    return { ok: o.status === 'CREATED' && confirmStatus === 'APPROVED' && a.authStatus === 'CREATED', detail: `order ${o.orderId} ${o.status} -> ${confirmStatus} -> auth ${a.authorizationId} ${a.authStatus}` }
  })

  await step('Tab D: capture with PayPal-Mock-Response AUTHORIZATION_EXPIRED', '422 AUTHORIZATION_EXPIRED (failed-settlement path)', () =>
    expectIssue(() => pp.captureTab({ roomId, fanId: fans.D, authorizationId: s.authD!, amountCents: 500, noteToPayer: 'mock', mock: 'AUTHORIZATION_EXPIRED' }), 'AUTHORIZATION_EXPIRED'),
  )

  await step('Tab D: retry the settlement as attempt 1 (-a1)', 'COMPLETED', async () => {
    const c = await pp.captureTab({ roomId, fanId: fans.D, authorizationId: s.authD!, amountCents: 500, noteToPayer: 'AnswerTab: Q2 answered (proof run).', attempt: 1 })
    return { ok: c.status === 'COMPLETED', detail: `capture ${c.captureId} ${c.status}, fee ${c.feeCents}c` }
  })

  await step('Tab E: PayPal wallet AUTHORIZE order', 'PAYER_ACTION_REQUIRED with an approval link (buyer login not automated)', async () => {
    const o = await pp.createAuthorizeOrder({ roomId, fanId: fans.E, ceilingCents: 2000, funding: 'paypal' })
    return { ok: o.status === 'PAYER_ACTION_REQUIRED' && !!o.approveUrl, detail: `order ${o.orderId} ${o.status}, approval link ${o.approveUrl ? 'present' : 'missing'}` }
  })

  const contestId = `ct_proof${runId}`
  await db.query(`INSERT INTO questions (id, room_id, number, asker_fan_id, text, clean_text, asked_at_ms) VALUES ('q_proof', $1, 1, $2, 'q', 'q', 0)`, [roomId, fans.A])
  await db.query(`INSERT INTO backings (id, question_id, room_id, fan_id, tab_id, kind, amount_cents, backed_at_ms) VALUES ('b_proof', 'q_proof', $1, $2, $3, 'ask', 300, 0)`, [roomId, fans.A, `tab_${fans.A}`])
  await db.query(`INSERT INTO contests (id, room_id, tab_id, backing_id, reason) VALUES ($1, $2, $3, 'b_proof', 'not answered')`, [contestId, roomId, `tab_${fans.A}`])

  await step('Contest refund: $3 of capture A via Agent Toolkit create_refund, then get_refund', 'refund COMPLETED, path toolkit, PayPal keeps the fee', async () => {
    const r = await pp.refundShare({ contestId, captureId: s.captureA!, amountCents: 300, noteToPayer: 'AnswerTab: contest upheld for Q1, $3.00 back.' })
    s.refund = r.refundId
    return { ok: r.status === 'COMPLETED' && r.grossCents === 300 && r.path === 'toolkit', detail: `refund ${r.refundId} ${r.status} via ${r.path}, gross ${r.grossCents}c fee returned ${r.feeReturnedCents}c net ${r.netCents}c` }
  })

  await step('Contest refund replay: same request id refund-{contest}', 'same refund id', async () => {
    const r = await pp.refundShare({ contestId, captureId: s.captureA!, amountCents: 300, noteToPayer: 'AnswerTab: contest upheld for Q1, $3.00 back.' })
    return { ok: r.refundId === s.refund, detail: `refund ${r.refundId}, same as first: ${r.refundId === s.refund}` }
  })

  await step('Agent Toolkit get_order on tab A', 'auth CAPTURED, capture listed', async () => {
    const o = await pp.getOrder(s.orderA!, { roomId, fanId: fans.A })
    return { ok: o.authStatus === 'CAPTURED' && o.captureIds.includes(s.captureA!), detail: `order ${o.orderId} ${o.status}, auth ${o.authStatus}, captures ${o.captureIds.join(',')}` }
  })

  await step('Agent Toolkit get_dispute on an unknown id', '404 RESOURCE_NOT_FOUND mapped to PayPalError', () => expectIssue(() => pp.getDispute(`PP-D-PROOF${runId}`, { roomId }), 'RESOURCE_NOT_FOUND'))

  const email = cfg.paypal.creatorPayeeEmail
  await step('Payout $1 to the US sandbox creator', 'batch created, then readable', async () => {
    if (!email) return { ok: false, detail: 'PAYPAL_CREATOR_PAYEE_EMAIL not set' }
    await db.query(`INSERT INTO payouts (id, room_id, attempt, sender_batch_id, receiver, amount_cents) VALUES ('po_proof', $1, 1, $2, 'creator', 100)`, [roomId, `payout-${roomId}-1`])
    const p = await pp.createPayout({ roomId, attempt: 1, receiverEmail: email, amountCents: 100, note: 'AnswerTab sandbox proof payout' })
    const b = await pp.getPayoutBatch(p.payoutBatchId, { roomId })
    s.batch = p.payoutBatchId
    return { ok: !!p.payoutBatchId && b.payoutBatchId === p.payoutBatchId, detail: `batch ${p.payoutBatchId} ${p.batchStatus}; GET ${b.batchStatus}, item ${b.items[0]?.transactionStatus ?? '-'}` }
  })

  await step('Payout again with the same sender_batch_id', 'PayPal rejects (400); answered from the stored payout_batch_id', async () => {
    if (!email) return { ok: false, detail: 'PAYPAL_CREATOR_PAYEE_EMAIL not set' }
    const p = await pp.createPayout({ roomId, attempt: 1, receiverEmail: email, amountCents: 100, note: 'AnswerTab sandbox proof payout' })
    const rejected = calls.filter((c) => c.step === current && c.call.op === 'payouts.create').at(-1)?.call
    return { ok: p.recovered && p.payoutBatchId === s.batch, detail: `PayPal HTTP ${rejected?.httpStatus} ${rejected?.resourceStatus}; recovered batch ${p.payoutBatchId}` }
  })

  await step('Reporting balances', 'USD balance readable', async () => {
    const b = await pp.getBalances()
    const usd = b.balances.find((x) => x.currency === 'USD')
    return { ok: !!usd, detail: `USD total ${usd ? (usd.totalCents! / 100).toFixed(2) : '-'}` }
  })

  await step('List webhooks (read-only)', 'listing works', async () => {
    const w = await pp.listWebhooks()
    return { ok: true, detail: `${w.length} webhook(s) registered on this app` }
  })

  // ---------- output ----------
  const root = path.resolve(import.meta.dirname, '../..')
  const rows = await db.query(`SELECT * FROM paypal_calls ORDER BY created_at, id`)
  mkdirSync(path.join(root, 'scripts/sandbox-proof/out'), { recursive: true })
  writeFileSync(path.join(root, `scripts/sandbox-proof/out/${runId}.json`), JSON.stringify({ runId, roomId, startedAt, steps, calls: rows }, null, 1))
  writeFileSync(path.join(root, 'docs/sandbox-proof.md'), renderMarkdown(startedAt))
  await db.close()
  const failed = steps.filter((x) => !x.ok)
  console.log(`\n${steps.length - failed.length}/${steps.length} steps passed, ${calls.length} PayPal calls. Wrote docs/sandbox-proof.md`)
  if (failed.length) process.exitCode = 1
}

const cell = (v: unknown) => String(v ?? '-').replace(/\|/g, '\\|')

function renderMarkdown(startedAt: Date): string {
  const passed = steps.filter((x) => x.ok).length
  const lines = [
    '# PayPal sandbox proof',
    '',
    `Run \`${runId}\` (room \`${roomId}\`), started ${startedAt.toISOString()}. Generated by \`npm run sandbox:proof\` (scripts/sandbox-proof/run.ts),`,
    'which drives `src/server/paypal` exactly as the app does against the PayPal sandbox. Every row below is a real HTTP call;',
    'debug ids can be looked up by PayPal. Card data, tokens and payer details are redacted in the ledger; nothing secret is printed here.',
    '',
    `**${passed}/${steps.length} steps passed, ${calls.length} PayPal calls.**`,
    '',
    '## Steps',
    '',
    '| # | Step | Expected | Result | Detail | Time |',
    '|---|---|---|---|---|---|',
    ...steps.map((x) => `| ${x.n} | ${cell(x.label)} | ${cell(x.expected)} | ${x.ok ? 'pass' : '**FAIL**'} | ${cell(x.detail)} | ${(x.ms / 1000).toFixed(1)} s |`),
    '',
    '## Ledger (every PayPal call)',
    '',
    'Ops ending in `:toolkit` went through `@paypal/agent-toolkit` 1.11.0; `toolkit.oauth.token` is the token each fresh toolkit instance fetches.',
    'Everything else went through `@paypal/paypal-server-sdk` 2.5.0 (Orders, Payments) or typed fetch (OAuth, Payouts, balances, webhooks).',
    '',
    '| Step | Op | Method | Endpoint | PayPal-Request-Id | HTTP | Resource | Status | Debug id | Latency |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...calls.map(({ step: n, call: c }) => `| ${n} | ${cell(c.op)} | ${c.method} | ${cell(c.endpoint)} | ${cell(c.requestId)} | ${c.httpStatus} | ${cell(c.resourceId)} | ${cell(c.resourceStatus)} | ${cell(c.debugId)} | ${c.latencyMs} ms |`),
    '',
    `Latency summary: ${latencySummary()}.`,
    '',
  ]
  return lines.join('\n')
}

function latencySummary(): string {
  const groups = new Map<string, number[]>()
  for (const { call } of calls) {
    if (call.httpStatus < 200 || call.httpStatus >= 300) continue
    const key = call.op.replace(/:.*$/, '')
    groups.set(key, [...(groups.get(key) ?? []), call.latencyMs])
  }
  return [...groups.entries()].map(([k, v]) => `${k} ${Math.min(...v)}–${Math.max(...v)} ms (n=${v.length})`).join('; ')
}

main().catch((e) => {
  console.error('sandbox proof crashed:', pp.toPayPalError(e).message)
  process.exitCode = 1
})
