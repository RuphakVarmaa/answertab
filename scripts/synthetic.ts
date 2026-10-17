// One synthetic run of the whole judge path with fresh IDs, against the real PayPal sandbox and (when
// ANTHROPIC_API_KEY is set) the real model. Records the result in synthetic_runs and exits non-zero on failure.
//   npm run synthetic                 # uses DATABASE_URL, else PGlite at PGLITE_DIR (default .data/pglite)
//   npm run synthetic -- --json       # print the stored details as JSON
// Do not point PGLITE_DIR at the folder of a server that is running: PGlite allows one process per folder.
import { loadConfig } from '../src/server/config.js'
import { openDb, setDb } from '../src/server/db/db.js'
import { initDomain, stopAllDetectors } from '../src/server/domain/index.js'
import { runSynthetic } from '../src/server/demo/synthetic.js'

async function main(): Promise<number> {
  const cfg = loadConfig() // throws unless PAYPAL_ENVIRONMENT=sandbox
  const json = process.argv.includes('--json')
  const db = await openDb({ databaseUrl: cfg.databaseUrl, pgliteDir: process.env.PGLITE_DIR || undefined })
  setDb(db)
  initDomain()
  console.log(`synthetic run: ${db.kind}, PayPal sandbox, ${cfg.anthropicApiKey ? 'real Claude' : 'manual-confirm mode (no Anthropic key)'}`)
  const r = await runSynthetic({ log: (m) => console.log(`  ${m}`) })
  const d = r.details
  if (json) console.log(JSON.stringify({ id: r.id, ok: r.ok, roomId: r.roomId, details: d }, null, 1))
  else {
    console.log(`\nrun ${r.id}  room ${r.roomId ?? '-'}  ${r.ok ? 'PASSED' : 'FAILED'}`)
    for (const t of d.paypal.tabs) {
      console.log(`  ${t.fan.padEnd(5)} ${t.state.padEnd(9)} order ${t.orderId ?? '-'}  auth ${t.authorizationId ?? '-'} (${t.authStatus ?? '-'})  capture ${t.captureId ?? '-'} ${t.capturedCents}c fee ${t.feeCents ?? '-'}c`)
    }
    if (d.paypal.refund) console.log(`  refund  ${d.paypal.refund.refundId ?? '-'} (${d.paypal.refund.refundCents ?? 0}c, desk ${d.paypal.refund.state}, finding ${d.paypal.refund.finding ?? '-'})`)
    if (d.paypal.payout) console.log(`  payout  ${d.paypal.payout.payoutBatchId ?? '-'} ${d.paypal.payout.batchStatus ?? '-'} (${d.paypal.payout.amountCents}c, fee ${d.paypal.payout.feeCents ?? '-'}c)`)
    console.log(`  ledger  ${d.paypal.ledger.calls} calls, ${d.paypal.ledger.errors.length} errors${d.paypal.ledger.errors.map((e) => ` [${e.op} ${e.httpStatus} ${e.debugId ?? ''}]`).join('')}`)
    console.log(`  LLM     $${(d.costs.llmMicros / 1e6).toFixed(4)}  ${Object.entries(d.costs.byPurpose).map(([k, v]) => `${k} ${v.calls}x $${(v.micros / 1e6).toFixed(4)}`).join(', ')}`)
    console.log(`  timings ${Object.entries(d.timings).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}s`).join(', ')}`)
  }
  stopAllDetectors()
  await db.close()
  return r.ok ? 0 : 1
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`synthetic run crashed: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(2)
  },
)
