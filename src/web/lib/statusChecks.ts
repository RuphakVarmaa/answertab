// /api/status checks in plain words, and when the PayPal sandbox is too degraded for a live demo.
import type { StatusCheck } from '../../shared/types.js'

const LABELS: Record<string, string> = {
  paypal_oauth: 'PayPal sign-in',
  paypal_webhook: 'PayPal webhooks',
  paypal_balance: 'PayPal sandbox balance',
  anthropic: 'Claude',
  llm_budget_judge: "Claude budget (judges' pool)",
  llm_budget_public: 'Claude budget (public pool)',
  synthetic_run: 'Last end-to-end test run',
}

export function checkLabel(name: string): string {
  return LABELS[name] ?? name.replace(/_/g, ' ')
}

/**
 * PayPal checks that a live demo depends on are failing. Webhooks only reconcile (the UI never waits on
 * them), so a webhook problem alone does not count.
 */
export function paypalDegraded(checks: readonly StatusCheck[] | null | undefined): boolean {
  return (checks ?? []).some((c) => !c.ok && c.name.startsWith('paypal_') && c.name !== 'paypal_webhook')
}

const PAYPAL_AFFECTING: ReadonlySet<string> = new Set(['paypal_oauth', 'paypal_balance'])
const CLAUDE_AFFECTING: ReadonlySet<string> = new Set(['anthropic', 'llm_budget_judge', 'llm_budget_public'])

/**
 * Failing checks a judge would notice in a demo room. Webhooks and the last synthetic run are setup
 * signals (webhooks only reconcile; a stale run is not a live failure), so they stay on /status only.
 */
export function judgeAffecting(checks: readonly StatusCheck[] | null | undefined): StatusCheck[] {
  return (checks ?? []).filter((c) => !c.ok && (PAYPAL_AFFECTING.has(c.name) || CLAUDE_AFFECTING.has(c.name)))
}

export interface LandingAlert {
  /** Judge-affecting failures to name in the banner; empty means no banner. */
  failing: StatusCheck[]
  /** Show the recorded run, and why: PayPal holds may fail, or Claude is off and the replay will not lock. */
  recorded: 'paypal' | 'claude' | null
}

/** What the landing page warns about. PayPal wins the recorded-run wording when both are failing. */
export function landingAlert(checks: readonly StatusCheck[] | null | undefined, hasRecordedRun: boolean): LandingAlert {
  const failing = judgeAffecting(checks)
  const cause = failing.some((c) => PAYPAL_AFFECTING.has(c.name)) ? 'paypal' : failing.length > 0 ? 'claude' : null
  return { failing, recorded: hasRecordedRun ? cause : null }
}
