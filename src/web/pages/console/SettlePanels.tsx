// End stream -> review (approve locks, rate partials) -> settle with progress -> per-fan results.
import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import type { Rating } from '../../../shared/types.js'
import { Icon } from '../../components/Icon.js'
import { Quote } from '../../components/QuestionCard.js'
import { StateChip } from '../../components/StateChip.js'
import { Banner, Empty, Id } from '../../components/ui.js'
import { cardStatus } from '../../lib/cardState.js'
import { isQuoteTruncated, money, plural, timeUntil } from '../../lib/format.js'
import { resultsTotals } from '../../lib/results.js'
import { defaultRatings, isChargeable, isPending, maxChargeCents, needsRating, reviewSummary, settleRatings, type DraftRatings, type ReviewItemIn } from '../../lib/review.js'
import { paths } from '../../lib/url.js'
import type { ConsoleModel } from './useConsole.js'

const RATINGS: { value: Rating; label: string }[] = [
  { value: 'full', label: 'Full' },
  { value: 'half', label: 'Half' },
  { value: 'none', label: 'None' },
]

function RatingPicker({ value, onChange, name, disabled }: { value: Rating | null; onChange: (r: Rating) => void; name: string; disabled?: boolean }) {
  return (
    <div className="seg" role="radiogroup" aria-label={name}>
      {RATINGS.map((r) => (
        <button key={r.value} type="button" role="radio" aria-checked={value === r.value} onClick={() => onChange(r.value)} disabled={disabled}>
          {r.label}
        </button>
      ))}
    </div>
  )
}

function ReviewRow({ item, rating, onRate, disabled }: { item: ReviewItemIn; rating: Rating | null; onRate: (r: Rating) => void; disabled: boolean }) {
  const st = cardStatus({ state: item.state, backedCents: item.lockedCents, rating: null, creatorConfirmed: false })
  const max = maxChargeCents(item.lockedCents, rating)
  const pending = isPending(item)
  return (
    <li className="review__item" data-tone={st.tone}>
      <div className="row">
        <span className="qcard__num">#{item.questionNumber}</span>
        <StateChip
          icon={item.state === 'locked' && needsRating(item) ? 'flag' : st.icon}
          label={item.state === 'review' ? 'Partial — rate it' : needsRating(item) ? 'Locked after End — rate it' : st.label}
          tone={needsRating(item) ? 'warn' : st.tone}
        />
        <span className="spacer" />
        <span className="small muted num">
          {plural(item.backers, 'fan')} · {money(item.lockedCents, { compact: true })} held
        </span>
      </div>
      <p className="review__q">{item.text}</p>
      {item.quote ? <Quote text={item.quote} atMs={null} source={null} truncated={isQuoteTruncated(item)} tone={st.tone} /> : <p className="small muted">No quote on this card.</p>}
      {pending ? (
        <p className="small muted">Claude Opus is still checking this quote. Settle unlocks when it finishes; until then nothing on this card can be charged.</p>
      ) : (
        <div className="row">
          <RatingPicker value={rating} onChange={onRate} name={`Rating for question ${item.questionNumber}`} disabled={disabled} />
          <span className="small num">
            {rating === null ? <span className="muted">Not rated — not charged</span> : rating === 'none' ? 'Not charged' : rating === 'half' ? `Up to ${money(max)} (halves round down)` : `${money(max)} captured`}
          </span>
        </div>
      )}
    </li>
  )
}

export function ReviewPanel({ model }: { model: ConsoleModel }) {
  const view = model.view!
  const items = model.review
  const [draft, setDraft] = useState<DraftRatings>({})
  useEffect(() => {
    if (items) setDraft((d) => ({ ...defaultRatings(items), ...d }))
  }, [items])
  const inFlight = model.busy === 'settle'
  const stuck = view.room.status === 'settling' && !inFlight
  const settling = inFlight || view.room.status === 'settling'
  const chargeable = useMemo(() => (items ?? []).filter((i) => isChargeable(i) || isPending(i)), [items])
  const released = useMemo(() => (items ?? []).filter((i) => !isChargeable(i) && !isPending(i)), [items])
  const pending = chargeable.filter(isPending)

  if (!items) return <Empty icon="spinner">Loading the review list…</Empty>
  const sum = reviewSummary(items, draft)
  const p = model.settle && model.settle.total > 0 ? Math.round((model.settle.done / model.settle.total) * 100) : null

  return (
    <div className="review stack gap-4">
      <div className="review__head">
        <h3 className="display review__title">
          {plural(sum.locks, 'lock')} with quotes{sum.partials > 0 ? `, ${plural(sum.partials, 'partial')} to rate` : ''}
        </h3>
        <p className="small muted">
          Nothing is charged until you approve. Approving captures once per fan for answered cards and releases the rest of every hold.
          {view.room.endedAt && ' If nobody approves before the deadline, every tab is voided.'}
        </p>
      </div>
      {chargeable.length === 0 ? (
        <Banner tone="info">No card has an accepted answer. Settling voids every hold; nobody is charged.</Banner>
      ) : (
        <ol className="review__list">
          {chargeable.map((it) => (
            <ReviewRow key={it.questionId} item={it} rating={draft[it.questionNumber] ?? null} onRate={(r) => setDraft((d) => ({ ...d, [it.questionNumber]: r }))} disabled={settling} />
          ))}
        </ol>
      )}
      {released.length > 0 && (
        <details className="review__released">
          <summary className="small">
            {plural(released.length, 'card')} not answered — holds released, not charged
          </summary>
          <ul>
            {released.map((it) => (
              <li key={it.questionId} className="small">
                <span className="qcard__num">#{it.questionNumber}</span> {it.text}
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="review__foot">
        {stuck ? (
          <div className="stack gap-2 review__retry" role="status">
            <Banner tone="warn">
              <strong>Settlement did not finish.</strong> PayPal did not confirm every tab, so the room is still settling. Retrying is safe: each fan keeps one
              capture with the same request ID, so nobody is charged twice.
              {model.settleErrors.length > 0 && (
                <ul className="review__errors">
                  {model.settleErrors.map((e, i) => (
                    <li key={`${e.tabId ?? 'room'}:${i}`} className="small">
                      {e.tabId ? <>{view.tabs.find((t) => t.id === e.tabId)?.displayName ?? 'A tab'}: </> : null}
                      {e.message}
                    </li>
                  ))}
                </ul>
              )}
            </Banner>
            <div className="row gap-3">
              <button type="button" className="btn btn--primary btn--lg" onClick={() => model.actions.settle(settleRatings(items, draft))}>
                <Icon name="refresh" />
                Retry settlement
              </button>
              {model.settle && model.settle.total > 0 && <span className="small muted num">{`${model.settle.done} of ${model.settle.total} tabs settled`}</span>}
            </div>
          </div>
        ) : settling ? (
          <div className="stack gap-2" role="status">
            <div className={['progress', p === null ? 'is-indeterminate' : ''].join(' ')} style={p !== null ? ({ '--p': `${p}%` } as CSSProperties) : undefined}>
              <span />
            </div>
            <span className="small num">{model.settle && model.settle.total > 0 ? `Settling with PayPal: ${model.settle.done} of ${model.settle.total} tabs` : 'Settling with PayPal…'}</span>
          </div>
        ) : (
          <>
            <button type="button" className="btn btn--primary btn--lg" onClick={() => model.actions.settle(settleRatings(items, draft))} disabled={pending.length > 0}>
              <Icon name={pending.length ? 'spinner' : 'check'} />
              {pending.length ? 'Waiting for Claude…' : chargeable.length ? 'Approve all and settle' : 'Settle (void every hold)'}
            </button>
            <span className="small muted num">
              {pending.length > 0
                ? `${pending.map((i) => `#${i.questionNumber}`).join(', ')} still being checked`
                : sum.upToCents > 0
                  ? `Up to ${money(sum.upToCents)} captured in total, one capture per fan`
                  : 'Nothing will be captured'}
              {pending.length === 0 && sum.unrated > 0 && ` · ${plural(sum.unrated, 'unrated partial')} not charged`}
            </span>
          </>
        )}
      </div>
    </div>
  )
}

export function ResultsPanel({ model }: { model: ConsoleModel }) {
  const view = model.view!
  const tabs = view.tabs.filter((t) => t.state !== 'opening')
  const totals = resultsTotals(view)
  const { grossCents: captured, feeCents: fees, refundedCents: refunded, netCents: net, feesKnown } = totals
  const answered = view.room.questions.filter((q) => q.state === 'approved' && q.rating !== 'none')
  const carry = view.room.questions.filter((q) => q.state === 'open' || q.state === 'deflected' || q.state === 'unpaid' || (q.state === 'approved' && q.rating === 'none'))

  return (
    <div className="results stack gap-4">
      <div className="results__summary">
        <div>
          <span className="label">Captured</span>
          <strong className="num results__big">{money(captured)}</strong>
        </div>
        <div>
          <span className="label">PayPal fees</span>
          <strong className="num">{feesKnown ? money(fees) : `${money(fees)}+`}</strong>
          <span className="xsmall muted">from PayPal's responses</span>
        </div>
        <div>
          <span className="label">Net</span>
          <strong className="num">{money(net)}</strong>
          {refunded > 0 && <span className="xsmall muted num">after {money(refunded)} refunded</span>}
        </div>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Fan</th>
              <th className="r">Hold</th>
              <th className="r">Captured</th>
              <th className="r">Released</th>
              {refunded > 0 && <th className="r">Refunded</th>}
              <th className="r">PayPal fee</th>
              <th>Capture or void</th>
              <th>Receipt</th>
            </tr>
          </thead>
          <tbody>
            {tabs.map((t) => (
              <tr key={t.id}>
                <td>
                  {t.displayName} {t.isBot && <span className="tag">bot</span>}
                </td>
                <td className="r num">{money(t.ceilingCents)}</td>
                <td className="r num">{t.capturedCents > 0 ? money(t.capturedCents) : '—'}</td>
                <td className="r num">{money(t.releasedCents)}</td>
                {refunded > 0 && <td className="r num">{t.refundedCents > 0 ? money(t.refundedCents) : '—'}</td>}
                <td className="r num">{t.feeCents !== null ? money(t.feeCents) : t.capturedCents > 0 ? <span className="muted">pending</span> : '—'}</td>
                <td>
                  {t.state === 'declined' ? (
                    <span className="small muted">Declined at hold, never charged</span>
                  ) : t.captureId ? (
                    <Id value={t.captureId} />
                  ) : t.state === 'voided' ? (
                    <span className="small">
                      Voided, hold released <Id value={t.authorizationId} />
                    </span>
                  ) : (
                    <span className="small muted">{t.state}</span>
                  )}
                </td>
                <td>{t.receiptToken ? <Link to={paths.receipt(t.receiptToken)} target="_blank" rel="noopener">Open</Link> : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="recap small">
        <strong>Recap.</strong> {plural(answered.length, 'question')} answered and charged, {plural(carry.length, 'question')} not charged. Gross {money(captured)}, PayPal
        fees {money(fees)}{refunded > 0 ? `, refunds ${money(refunded)}` : ''}, net {money(net)} before the platform fee and payout.
        {carry.length > 0 && <> Carry over: {carry.slice(0, 3).map((q) => `#${q.number} "${q.text.slice(0, 60)}"`).join('; ')}.</>}
        {view.room.contestWindowEndsAt && <> Contest window closes {timeUntil(view.room.contestWindowEndsAt)}.</>}
      </p>
    </div>
  )
}
