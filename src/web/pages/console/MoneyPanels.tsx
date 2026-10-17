// Tabs, PayPal ledger, contests and payout: everything that shows PayPal state as PayPal reported it.
import { Fragment, useState } from 'react'
import type { LedgerCallView, TabView } from '../../../shared/types.js'
import { Icon } from '../../components/Icon.js'
import { Quote } from '../../components/QuestionCard.js'
import { Badge, StateChip } from '../../components/StateChip.js'
import { ContestCard, TabStateChip } from '../../components/Status.js'
import { Banner, Empty, Id, useNow } from '../../components/ui.js'
import type { DisputeView, ReplayResult } from '../../lib/api.js'
import type { Tone } from '../../lib/cardState.js'
import { disputeIsOpen, evidenceFileName, humanize, summarizeEvidence } from '../../lib/disputes.js'
import { money, timeAgo, timeUntil } from '../../lib/format.js'
import { normalizeWebhooks, webhookAgo } from '../../lib/webhooks.js'
import type { ConsoleModel } from './useConsole.js'

export function TabsPanel({ model }: { model: ConsoleModel }) {
  const tabs = model.view!.tabs
  if (tabs.length === 0) return <Empty icon="card">No tabs yet. Fans open a hold from the fan link.</Empty>
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Fan</th>
            <th className="r">Hold</th>
            <th className="r">Reserved</th>
            <th>State</th>
            <th>Authorization</th>
          </tr>
        </thead>
        <tbody>
          {tabs.map((t: TabView & { displayName: string; isBot: boolean }) => (
            <tr key={t.id}>
              <td>
                {t.displayName} {t.isBot && <span className="tag">bot</span>}
                <div className="xsmall muted">{t.funding === 'bot_card' ? 'test card (server)' : t.funding === 'card' ? 'card fields' : 'PayPal'}</div>
              </td>
              <td className="r num">{money(t.ceilingCents)}</td>
              <td className="r num">{money(t.reservedCents)}</td>
              <td>
                <TabStateChip state={t.state} />
                {t.declineReason && <div className="xsmall muted">{t.declineReason}</div>}
              </td>
              <td>
                <Id value={t.authorizationId} />
                {t.authStatus && <div className="xsmall muted mono">{t.authStatus}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function httpTone(status: number): Tone {
  if (status >= 200 && status < 300) return 'ok'
  if (status === 0) return 'bad'
  if (status >= 400) return 'bad'
  return 'warn'
}

function isReplayable(c: LedgerCallView): boolean {
  return /capture/i.test(c.op) && c.method === 'POST' && c.httpStatus >= 200 && c.httpStatus < 300
}

function LedgerRow({ c, model }: { c: LedgerCallView; model: ConsoleModel }) {
  const [result, setResult] = useState<ReplayResult | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const replay = async () => {
    setErr(null)
    try {
      const r = await model.actions.replay(c.id)
      if (r) setResult(r)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Replay failed')
    }
  }
  const tone = httpTone(c.httpStatus)
  return (
    <li className="lrow">
      <div className="lrow__main">
        <span className="badge num" data-tone={tone} title={`HTTP ${c.httpStatus}`}>
          <Icon name={tone === 'ok' ? 'check' : 'x'} />
          {c.httpStatus || 'ERR'}
        </span>
        <span className="lrow__op">{c.op}</span>
        <span className="mono lrow__ep">
          {c.method} {c.endpoint}
        </span>
        <span className="spacer" />
        <span className="xsmall muted num">{c.latencyMs} ms</span>
        <span className="xsmall muted">{timeAgo(c.at)}</span>
      </div>
      <dl className="lrow__ids">
        <div>
          <dt>PayPal-Request-Id</dt>
          <dd>
            <Id value={c.requestId} empty="none (read)" />
          </dd>
        </div>
        <div>
          <dt>Resource</dt>
          <dd>
            <Id value={c.resourceId} /> {c.resourceStatus && <span className="mono xsmall">{c.resourceStatus}</span>}
          </dd>
        </div>
        <div>
          <dt>debug_id</dt>
          <dd>
            <Id value={c.debugId} />
          </dd>
        </div>
      </dl>
      {isReplayable(c) && (
        <div className="row gap-2">
          <button type="button" className="btn btn--sm" onClick={replay} disabled={model.busy === `replay:${c.id}`}>
            <Icon name={model.busy === `replay:${c.id}` ? 'spinner' : 'refresh'} />
            Replay to PayPal
          </button>
          {result && (
            <span className="small" role="status" data-tone={result.sameAsOriginal ? 'ok' : 'bad'}>
              <StateChip
                icon={result.sameAsOriginal ? 'checkCircle' : 'alert'}
                tone={result.sameAsOriginal ? 'ok' : 'bad'}
                label={result.sameAsOriginal ? 'Same capture ID — idempotent' : 'Different capture ID'}
              />{' '}
              <Id value={result.captureId} />
              {result.httpStatus ? <span className="muted num"> HTTP {result.httpStatus}</span> : null}
            </span>
          )}
          {err && <span className="small" style={{ color: 'var(--c-bad)' }}>{err}</span>}
        </div>
      )}
    </li>
  )
}

/** Verified PayPal webhook events for this room (GET /console `webhooks`). Hidden when the server sends none. */
function WebhookList({ raw }: { raw: unknown }) {
  const now = useNow(5000)
  const events = normalizeWebhooks(raw)
  if (!events) return null
  return (
    <section className="webhooks" aria-labelledby="webhooks-title">
      <div className="row">
        <Icon name="webhook" />
        <h3 id="webhooks-title" className="label">
          PayPal webhooks
        </h3>
        <span className="xsmall muted num">{events.length}</span>
      </div>
      {events.length === 0 ? (
        <p className="xsmall muted">No verified events yet. Webhooks only reconcile; nothing here waits on one.</p>
      ) : (
        <ol className="webhooks__list">
          {events.map((e) => (
            <li key={e.id}>
              <Badge icon="check" tone="ok" title="Signature verified with PayPal" className="webhooks__ok">
                <span className="webhooks__ok-text">Verified</span>
              </Badge>
              <span className="webhooks__what">
                <span className="mono small webhooks__type">
                  {/* Wrap at the dots, never mid-word. */}
                  {e.eventType.split('.').map((part, i) => (
                    <Fragment key={i}>
                      {i > 0 && (
                        <>
                          .<wbr />
                        </>
                      )}
                      {part}
                    </Fragment>
                  ))}
                </span>
                <Id value={e.resourceId} />
              </span>
              <span className="xsmall muted num webhooks__at" title={new Date(e.receivedAt).toLocaleString()}>
                {webhookAgo(e.receivedAt, now)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

export function LedgerPanel({ model }: { model: ConsoleModel }) {
  // The console snapshot arrives oldest-first; live events re-sort. Sort here so both agree.
  const calls = [...model.view!.ledger].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  if (calls.length === 0) return <Empty icon="bank">Every PayPal request appears here as it happens: endpoint, request ID, status and debug_id.</Empty>
  return (
    <>
      <WebhookList raw={model.view!.webhooks} />
      <p className="xsmall muted ledger__note">Card data and Authorization headers are removed before anything is stored. Newest first.</p>
      <ol className="ledger">
        {calls.map((c) => (
          <LedgerRow key={c.id} c={c} model={model} />
        ))}
      </ol>
    </>
  )
}

export function ContestsPanel({ model }: { model: ConsoleModel }) {
  const contests = model.view!.contests
  if (contests.length === 0)
    return <Empty icon="receipt">No contests. Fans can tap "I wasn't answered" on a receipt line within the contest window.</Empty>
  return (
    <div className="stack gap-3">
      <p className="xsmall muted">
        The contest desk (Claude Opus) can refund up to $5 on its own when it finds a question unanswered or deferred. Code computes every amount.
      </p>
      {contests.map((c) => (
        <ContestCard key={c.id} c={c} onDecide={(a) => model.actions.decide(c.id, a)} busy={model.busy === `decide:${c.id}`} />
      ))}
    </div>
  )
}

const PAYOUT_LABEL: Record<string, { label: string; icon: string; tone: Tone }> = {
  none: { label: 'Not sent', icon: 'clock', tone: 'neutral' },
  pending: { label: 'Pending at PayPal', icon: 'spinner', tone: 'warn' },
  success: { label: 'Paid out', icon: 'checkCircle', tone: 'ok' },
  denied: { label: 'Denied', icon: 'xCircle', tone: 'bad' },
  unclaimed: { label: 'Unclaimed', icon: 'alert', tone: 'warn' },
  failed: { label: 'Failed', icon: 'alert', tone: 'bad' },
}

export function PayoutPanel({ model }: { model: ConsoleModel }) {
  const view = model.view!
  const payout = view.payout
  const state = payout?.state ?? view.room.payoutState
  const s = PAYOUT_LABEL[state] ?? PAYOUT_LABEL.none!
  const settled = view.room.status === 'settled'
  const isDemo = view.room.kind === 'demo'
  return (
    <div className="stack gap-3">
      <div className="row">
        <StateChip icon={s.icon} label={s.label} tone={s.tone} />
        {payout?.webhookSeen && (
          <Badge icon="webhook" tone="ok" title="PayPal's webhook for this batch arrived and was verified">
            Webhook received
          </Badge>
        )}
        <span className="spacer" />
        {view.room.contestWindowEndsAt && state === 'none' && <span className="small muted">Contest window closes {timeUntil(view.room.contestWindowEndsAt)}</span>}
      </div>
      {payout ? (
        <dl className="dl">
          <dt>Amount</dt>
          <dd className="num">{money(payout.amountCents)}</dd>
          <dt>PayPal payout fee</dt>
          <dd className="num">{payout.feeCents !== null ? money(payout.feeCents) : 'not in response yet'}</dd>
          <dt>Batch</dt>
          <dd>
            <Id value={payout.payoutBatchId} />
          </dd>
          <dt>Batch status (API)</dt>
          <dd className="mono">{payout.batchStatus ?? '—'}</dd>
        </dl>
      ) : (
        <p className="small muted">
          After the contest window, AnswerTab sends one PayPal Payouts batch to the creator: capture net minus refunds minus the platform fee.
        </p>
      )}
      {isDemo && settled && state === 'none' && (
        <div className="row gap-2">
          <button type="button" className="btn btn--primary" onClick={() => model.actions.closeWindow()} disabled={model.busy === 'close'}>
            <Icon name={model.busy === 'close' ? 'spinner' : 'bank'} />
            Close contest window (demo)
          </button>
          <span className="xsmall muted">Demo control: skips the wait and sends the payout now.</span>
        </div>
      )}
      {!settled && <Banner tone="info">Payouts happen after settlement and the contest window.</Banner>}
    </div>
  )
}

function downloadJson(name: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function DisputeCard({ d, fanName }: { d: DisputeView; fanName: string | null }) {
  const open = disputeIsOpen(d)
  const ev = summarizeEvidence(d.evidencePack)
  return (
    <article className="dispute" data-tone={open ? 'warn' : 'muted'}>
      <div className="row">
        <StateChip icon={open ? 'alert' : 'checkCircle'} tone={open ? 'warn' : 'muted'} label={open ? `Dispute open · ${humanize(d.status)}` : `Dispute ${humanize(d.status).toLowerCase()}`} />
        {d.amountCents !== null && <strong className="num">{money(d.amountCents)}</strong>}
        <span className="spacer" />
        <span className="xsmall muted">{d.updatedAt ? `updated ${timeAgo(d.updatedAt)}` : ''}</span>
      </div>
      <dl className="dl dispute__facts">
        <dt>Fan</dt>
        <dd>{fanName ?? <span className="muted">not matched to a tab</span>}</dd>
        <dt>Reason</dt>
        <dd>{humanize(d.reason)}</dd>
        {ev?.sellerResponseDue && (
          <>
            <dt>Respond by</dt>
            <dd>{new Date(ev.sellerResponseDue).toLocaleString()}</dd>
          </>
        )}
        <dt>Dispute ID</dt>
        <dd>
          <Id value={d.id} />
        </dd>
      </dl>
      {open && <p className="xsmall muted">Contest refunds on this tab wait until PayPal closes the dispute.</p>}
      {ev ? (
        <section className="evidence" aria-label={`Evidence pack for dispute ${d.id}`}>
          <div className="row">
            <h3 className="label">Evidence pack</h3>
            <span className="spacer" />
            <button type="button" className="btn btn--sm" onClick={() => downloadJson(evidenceFileName(d), d.evidencePack)}>
              <Icon name="download" />
              Download JSON
            </button>
          </div>
          <p className="xsmall muted">
            The receipt as evidence: each question, the quote cut from the transcript with its room-clock time, PayPal IDs and contest history
            {ev.generatedAt ? `, generated ${timeAgo(ev.generatedAt)}` : ''}.
          </p>
          {ev.ids.length > 0 && (
            <dl className="evidence__ids">
              {ev.ids.map((x) => (
                <div key={x.label}>
                  <dt>{x.label}</dt>
                  <dd>
                    <Id value={x.value} />
                  </dd>
                </div>
              ))}
            </dl>
          )}
          <div className="evidence__money num small">
            {ev.holdCents !== null && <span>Hold {money(ev.holdCents)}</span>}
            {ev.capturedCents !== null && <span>Captured {money(ev.capturedCents)}</span>}
            {ev.refundedCents !== null && ev.refundedCents > 0 && <span>Refunded {money(ev.refundedCents)}</span>}
          </div>
          {ev.lines.length > 0 && (
            <ol className="evidence__lines">
              {ev.lines.map((l, i) => (
                <li key={`${l.questionNumber ?? 'q'}:${i}`}>
                  <div className="row">
                    {l.questionNumber !== null && <span className="qcard__num">#{l.questionNumber}</span>}
                    <span className="tag">{l.kind === 'ask' ? 'Asked' : 'Me too'}</span>
                    <span className="spacer" />
                    <span className="small num">
                      {l.chargeCents !== null && l.chargeCents > 0 ? `charged ${money(l.chargeCents)}` : 'not charged'}
                      {l.amountCents !== null && <span className="muted"> of {money(l.amountCents)}</span>}
                    </span>
                  </div>
                  <p className="small">{l.question}</p>
                  {l.quote && (
                    <Quote
                      text={l.quote}
                      atMs={l.quoteAtMs}
                      source={l.quoteSource === 'spoken' || l.quoteSource === 'typed' || l.quoteSource === 'replay' ? l.quoteSource : null}
                      creatorConfirmed={l.creatorConfirmed}
                      tone={l.chargeCents ? 'ok' : 'muted'}
                    />
                  )}
                </li>
              ))}
            </ol>
          )}
          {ev.contests.length > 0 && (
            <ul className="evidence__contests small">
              {ev.contests.map((c) => (
                <li key={c.id}>
                  Contest <span className="mono xsmall">{c.id}</span>: {humanize(c.state)}
                  {c.finding && <> · {humanize(c.finding)}</>}
                  {c.refundId && (
                    <>
                      {' '}
                      · refund {c.refundCents !== null && money(c.refundCents)} <Id value={c.refundId} />
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          <details className="evidence__raw">
            <summary className="small">Raw JSON</summary>
            <pre className="mono xsmall">{JSON.stringify(d.evidencePack, null, 2)}</pre>
          </details>
        </section>
      ) : (
        <p className="small muted">No evidence pack yet: PayPal's dispute has not been matched to a capture in this room.</p>
      )}
    </article>
  )
}

export function DisputesPanel({ model }: { model: ConsoleModel }) {
  const view = model.view!
  const disputes = view.disputes ?? []
  if (disputes.length === 0)
    return (
      <Empty icon="shield">
        No PayPal disputes. If a fan opens one, PayPal's webhook brings it here with an evidence pack built from the receipt: the quote, its timestamp and every
        PayPal ID.
      </Empty>
    )
  return (
    <div className="stack gap-3">
      {disputes.map((d) => (
        <DisputeCard key={d.id} d={d} fanName={view.tabs.find((t) => t.id === d.tabId)?.displayName ?? null} />
      ))}
    </div>
  )
}
