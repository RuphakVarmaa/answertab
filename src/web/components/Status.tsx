// Tab and contest states as chips: icon + words, color third.
import type { ContestView, TabState } from '../../shared/types.js'
import type { Tone } from '../lib/cardState.js'
import { money, timeAgo } from '../lib/format.js'
import { webhookBadgeLabel, type ContestWebhookIn } from '../lib/webhooks.js'
import { Badge, StateChip } from './StateChip.js'
import { Id, useNow } from './ui.js'

export const TAB_STATE: Record<TabState, { label: string; icon: string; tone: Tone }> = {
  opening: { label: 'Opening', icon: 'spinner', tone: 'neutral' },
  held: { label: 'Hold placed', icon: 'card', tone: 'info' },
  declined: { label: 'Declined — not charged', icon: 'xCircle', tone: 'bad' },
  settling: { label: 'Settling', icon: 'spinner', tone: 'warn' },
  captured: { label: 'Captured', icon: 'checkCircle', tone: 'ok' },
  voided: { label: 'Voided — released', icon: 'slash', tone: 'muted' },
  failed: { label: 'Failed', icon: 'alert', tone: 'bad' },
}

export function TabStateChip({ state }: { state: TabState }) {
  const s = TAB_STATE[state]
  return <StateChip icon={s.icon} label={s.label} tone={s.tone} />
}

const CONTEST_STATE: Record<ContestView['state'], { label: string; icon: string; tone: Tone }> = {
  open: { label: 'Received', icon: 'clock', tone: 'neutral' },
  deciding: { label: 'Contest desk reviewing', icon: 'spinner', tone: 'warn' },
  refunded: { label: 'Refunded', icon: 'checkCircle', tone: 'ok' },
  pending_creator: { label: 'Needs your decision', icon: 'flag', tone: 'warn' },
  upheld: { label: 'Charge kept', icon: 'lock', tone: 'info' },
  failed: { label: 'Desk failed — your call', icon: 'alert', tone: 'bad' },
}

/** "Confirmed by PayPal webhook, 12 s ago". Renders nothing until a verified event's time is known. */
export function WebhookBadge({ at }: { at: string | null | undefined }) {
  const now = useNow(5000)
  const label = webhookBadgeLabel(at, now)
  if (!label) return null
  return (
    <Badge icon="webhook" tone="ok" className="badge--webhook" title={`PayPal's signed webhook arrived and was verified at ${new Date(at!).toLocaleString()}`}>
      {label}
    </Badge>
  )
}

export function ContestCard({ c, onDecide, busy }: { c: ContestView; onDecide?: (approve: boolean) => void; busy?: boolean }) {
  const s = CONTEST_STATE[c.state]
  return (
    <article className="contest">
      <div className="row">
        <StateChip icon={s.icon} label={s.label} tone={s.tone} />
        {c.finding && <span className="tag">{c.finding.replace('_', ' ')}</span>}
        <span className="spacer" />
        <span className="xsmall muted">{timeAgo(c.createdAt)}</span>
      </div>
      {c.progress.length > 0 && (
        <ol className="timeline">
          {c.progress.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ol>
      )}
      {c.explanation && <p className="small">{c.explanation}</p>}
      {c.refundId && (
        <p className="small">
          Refund {c.refundCents !== null && <strong className="num">{money(c.refundCents)}</strong>} <Id value={c.refundId} />
        </p>
      )}
      {c.refundId && <WebhookBadge at={(c as ContestWebhookIn).refundWebhookAt} />}
      {onDecide && (c.state === 'pending_creator' || c.state === 'failed') && (
        <div className="row gap-2">
          <button type="button" className="btn btn--sm btn--primary" onClick={() => onDecide(true)} disabled={busy}>
            Approve refund
          </button>
          <button type="button" className="btn btn--sm" onClick={() => onDecide(false)} disabled={busy}>
            Keep the charge
          </button>
        </div>
      )}
    </article>
  )
}

