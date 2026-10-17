// One-time wiring of process-wide listeners (AI trouble -> manual mode, PayPal ledger -> SSE). Idempotent.
import { initDetection } from './detection.js'
import { initLedgerFeed } from './ledger.js'

let done = false

export function initDomain(): void {
  if (done) return
  done = true
  initDetection()
  initLedgerFeed()
}
