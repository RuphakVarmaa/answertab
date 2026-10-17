// Fallback when the PayPal sandbox is degraded: the last synthetic run that passed end to end, with its real
// PayPal IDs. Clearly labeled as recorded, never presented as this room's money.
import type { RecordedRun as Run } from '../lib/api.js'
import { timeAgo } from '../lib/format.js'
import { Icon } from './Icon.js'
import { Id } from './ui.js'

/** `cause` picks the explanation: PayPal checks failing (the default), or Claude unavailable or out of budget. */
export function RecordedRun({ run, compact, cause = 'paypal' }: { run: Run; compact?: boolean; cause?: 'paypal' | 'claude' }) {
  return (
    <section className={['recorded', compact ? 'recorded--compact' : ''].filter(Boolean).join(' ')} aria-labelledby="recorded-title">
      <div className="recorded__head">
        <span className="tag recorded__tag">
          <Icon name="replay" />
          Recorded run
        </span>
        <h2 id="recorded-title" className="recorded__title">
          The last full sandbox run that passed{run.finishedAt ? `, ${timeAgo(run.finishedAt)}` : ''}
        </h2>
      </div>
      <p className="small muted">
        {cause === 'claude'
          ? 'Claude is unavailable or out of budget right now, so a demo room runs in manual-confirm mode: the replay plays but nothing locks until the creator points at the answer.'
          : 'The PayPal sandbox is failing checks right now, so live holds may not go through.'}{' '}
        These are the real sandbox IDs from the last automated run of the same demo: holds, one capture per fan, a contest refund and the payout. Not this
        room's money.
      </p>
      <ol className="recorded__steps">
        {run.steps.map((s, i) => (
          <li key={`${s.paypalId}:${i}`}>
            <span className="recorded__name">{s.name}</span>
            <Id value={s.paypalId} />
            {s.status && <span className="tag">{s.status}</span>}
          </li>
        ))}
      </ol>
    </section>
  )
}
