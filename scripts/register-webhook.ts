// Registers (or updates) the sandbox webhook for PUBLIC_BASE_URL + '/webhooks/paypal'.
// Lists existing webhooks and PATCHes event_types on the one with this URL; creates one only if none exists.
// Prints the webhook id (not a secret) to put in PAYPAL_WEBHOOK_ID.
//   npm run webhook:register
import { config } from '../src/server/config.js'
import { openDb, setDb } from '../src/server/db/db.js'
import { ensureWebhook, toPayPalError, WEBHOOK_EVENT_TYPES } from '../src/server/paypal/index.js'

async function main() {
  const cfg = config()
  const url = `${cfg.publicBaseUrl}/webhooks/paypal`
  if (!url.startsWith('https://')) {
    console.error(`PUBLIC_BASE_URL must be a public https URL (got ${cfg.publicBaseUrl}); PayPal cannot deliver to localhost.`)
    process.exitCode = 1
    return
  }
  // The ledger needs a DB; this script's calls are not part of any room, so an in-memory one is enough.
  setDb(await openDb({ databaseUrl: null, pgliteDir: 'memory' }))
  const r = await ensureWebhook(url)
  console.log(`${r.created ? 'Created' : 'Updated'} webhook for ${url}`)
  console.log(`  event types (${r.eventTypes.length}/${WEBHOOK_EVENT_TYPES.length}): ${r.eventTypes.join(', ')}`)
  console.log(`  PAYPAL_WEBHOOK_ID=${r.webhookId}`)
  if (cfg.paypal.webhookId && cfg.paypal.webhookId !== r.webhookId) {
    console.log(`  note: PAYPAL_WEBHOOK_ID in the environment (${cfg.paypal.webhookId}) differs; update it.`)
  }
}

main().catch((e) => {
  const err = toPayPalError(e)
  console.error(`webhook registration failed: ${err.name}${err.issue ? `/${err.issue}` : ''} (HTTP ${err.httpStatus}, debug ${err.debugId ?? '-'}): ${err.message}`)
  process.exitCode = 1
})
