// Receipt: every line quotes the answer it paid for. "Verify with PayPal" re-reads the records live;
// "I wasn't answered" opens a contest the Claude contest desk reviews.
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useParams } from 'react-router-dom'
import type { ContestView, ReceiptLine, ReceiptView, RoomStatus } from '../../shared/types.js'
import { Icon } from '../components/Icon.js'
import { Logo } from '../components/Logo.js'
import { Quote } from '../components/QuestionCard.js'
import { isQuoteTruncated } from '../lib/format.js'
import { Badge, StateChip } from '../components/StateChip.js'
import { Banner, Id, useAction } from '../components/ui.js'
import { api, toApiError, type VerifyResult } from '../lib/api.js'
import { money, timeAgo, timeUntil } from '../lib/format.js'
import { friendlyError } from '../lib/messages.js'
import { lineStatus, type ReceiptLineIn } from '../lib/receipt.js'
import { PageError, PageLoading } from './Fallbacks.js'
import { ContestCard, TabStateChip, WebhookBadge } from '../components/Status.js'
import type { TabWebhookIn } from '../lib/webhooks.js'
import '../styles/receipt.css'

const ACTIVE: ContestView['state'][] = ['open', 'deciding']
const WEBHOOK_POLL_MS = 10_000
const WEBHOOK_POLLS = 18

/** GET /api/receipts/:token adds these to ReceiptView (all optional for older servers). */
type ReceiptPlus = Omit<ReceiptView, 'lines' | 'tab'> & {
  tab: TabWebhookIn
  lines: ReceiptLineIn[]
  roomStatus?: RoomStatus | null
  disputeOpen?: boolean
}

function ContestForm({ token, line, onDone }: { token: string; line: Pick<ReceiptLine, 'backingId'>; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const { busy, run } = useAction()
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!reason.trim()) return
    const r = await run('contest', () => api.contest(token, line.backingId, reason.trim()))
    if (r) {
      setOpen(false)
      onDone()
    }
  }
  if (!open)
    return (
      <button type="button" className="btn btn--sm" onClick={() => setOpen(true)}>
        <Icon name="flag" />
        I wasn't answered
      </button>
    )
  return (
    <form className="contestform" onSubmit={submit}>
      <label className="field">
        <span className="field__label">What was missing?</span>
        <textarea className="input" value={reason} onChange={(e) => setReason(e.target.value.slice(0, 500))} rows={3} placeholder="e.g. They said they'd cover it next week" required />
        <span className="field__hint">Claude's contest desk reads the transcript and PayPal's record. It can refund up to $5 on its own; larger refunds go to the creator.</span>
      </label>
      <div className="row gap-2">
        <button type="submit" className="btn btn--primary btn--sm" disabled={!reason.trim() || busy === 'contest'}>
          <Icon name={busy === 'contest' ? 'spinner' : 'send'} />
          Send contest
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  )
}

function Line({ line, token, canContest, onChanged, ctx }: { line: ReceiptLineIn; token: string; canContest: boolean; onChanged: () => void; ctx: Parameters<typeof lineStatus>[1] }) {
  const st = lineStatus(line, ctx)
  const charged = st.charged
  const reserved = st.kind === 'reserved'
  return (
    <li className="rline" data-tone={st.tone}>
      <div className="rline__head">
        <span className="qcard__num">#{line.questionNumber}</span>
        <span className="tag">{line.kind === 'ask' ? 'You asked' : 'Me too'}</span>
        <span className="spacer" />
        <span className="rline__amount num">
          {charged ? money(line.chargeCents ?? 0) : reserved ? money(line.amountCents) : <s className="muted">{money(line.amountCents)}</s>}
        </span>
      </div>
      <p className="rline__q">{line.questionText}</p>
      <div className="row">
        <StateChip icon={st.icon} tone={st.tone} label={st.label} />
        <span className="xsmall muted num">
          {charged ? `of ${money(line.amountCents)} held` : reserved ? `${money(line.amountCents)} reserved on your hold, not charged` : `${money(line.amountCents)} released`}
        </span>
      </div>
      {line.quote && (
        <Quote text={line.quote} atMs={line.quoteAtMs} source={line.quoteSource} creatorConfirmed={line.creatorConfirmed} truncated={isQuoteTruncated(line)} tone={charged ? 'ok' : 'muted'} />
      )}
      {line.contest ? <ContestCard c={line.contest} /> : charged && canContest ? <ContestForm token={token} line={line} onDone={onChanged} /> : null}
    </li>
  )
}

function VerifyBox({ token }: { token: string }) {
  const [result, setResult] = useState<VerifyResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const verify = async () => {
    setBusy(true)
    setError(null)
    try {
      setResult(await api.verifyReceipt(token))
    } catch (e) {
      setError(friendlyError(toApiError(e)))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="verify">
      <button type="button" className="btn" onClick={verify} disabled={busy}>
        <Icon name={busy ? 'spinner' : 'refresh'} />
        Verify with PayPal
      </button>
      {result && (
        <div className="verify__out" role="status" data-tone={result.matches === false ? 'warn' : result.matches ? 'ok' : 'neutral'}>
          {result.matches === false ? (
            <Banner tone="warn">
              <strong>PayPal's record differs from this receipt.</strong> Read live {timeAgo(result.verifiedAt)}.
              {result.mismatches.length > 0 && (
                <ul className="verify__mismatches">
                  {result.mismatches.map((m, i) => (
                    <li key={i}>{m}</li>
                  ))}
                </ul>
              )}
            </Banner>
          ) : (
            <p className="small">
              <Icon name={result.matches ? 'checkCircle' : 'info'} className="inline-icon" />{' '}
              {result.matches ? 'Matches this receipt. ' : ''}Read live from PayPal {timeAgo(result.verifiedAt)}:
            </p>
          )}
          <ul className="verify__list">
            {result.records.map((r) => (
              <li key={`${r.kind}:${r.id}`}>
                <span className="label">{r.kind}</span>
                <span className="row gap-2">
                  <Id value={r.id} />
                  <span className="tag">{r.status}</span>
                  {r.amountCents !== undefined && <span className="num small">{money(r.amountCents)}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && <Banner tone="bad">{error}</Banner>}
    </div>
  )
}

export default function ReceiptPage() {
  const { token = '' } = useParams()
  const [receipt, setReceipt] = useState<ReceiptPlus | null>(null)
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null)

  const load = useCallback(() => {
    api.receipt(token).then(
      (r) => {
        setReceipt(r as ReceiptPlus)
        setError(null)
      },
      (e) => setError(toApiError(e)),
    )
  }, [token])

  useEffect(() => {
    load()
    document.title = 'AnswerTab · Receipt'
  }, [load])

  // Contest desk progress notes arrive while it works; poll only while a contest is active.
  const active = receipt?.lines.some((l) => l.contest && ACTIVE.includes(l.contest.state)) ?? false
  useEffect(() => {
    if (!active) return
    const id = setInterval(load, 2500)
    return () => clearInterval(id)
  }, [active, load])

  // PayPal's capture webhook usually lands within a minute of settle. While the server reports the field but
  // has not seen the event, re-read a few times so the badge appears without a reload. Nothing waits on it.
  const awaitingWebhook = receipt?.tab.state === 'captured' && receipt.tab.captureWebhookAt === null
  useEffect(() => {
    if (!awaitingWebhook) return
    let polls = 0
    const id = setInterval(() => {
      polls += 1
      if (polls > WEBHOOK_POLLS) clearInterval(id)
      else load()
    }, WEBHOOK_POLL_MS)
    return () => clearInterval(id)
  }, [awaitingWebhook, load])

  if (!receipt) return error ? <PageError title="Receipt not found" detail={friendlyError(error)} /> : <PageLoading />
  const { tab } = receipt
  const deadline = receipt.contestDeadline ? Date.parse(receipt.contestDeadline) : null
  const canContest = deadline === null || deadline > Date.now()

  return (
    <div className="receipt-page">
      <header className="receipt-page__bar">
        <Logo />
        <span className="spacer" />
        <Badge icon="shield" className="badge--sandbox">
          Sandbox
        </Badge>
      </header>
      <main className="receipt">
        <div className="receipt__paper">
          <div className="receipt__top">
            <p className="label">Receipt</p>
            <h1 className="display receipt__title">{receipt.roomTitle}</h1>
            <p className="small muted">For {receipt.fanName}</p>
          </div>
          <dl className="receipt__totals">
            <div>
              <dt>Hold</dt>
              <dd>{money(tab.ceilingCents)}</dd>
            </div>
            <div>
              <dt>Charged</dt>
              <dd className="receipt__charged">{money(tab.capturedCents)}</dd>
            </div>
            <div>
              <dt>Released</dt>
              <dd>{money(tab.releasedCents)}</dd>
            </div>
            {tab.refundedCents > 0 && (
              <div>
                <dt>Refunded</dt>
                <dd>{money(tab.refundedCents)}</dd>
              </div>
            )}
          </dl>
          <div className="receipt__ids">
            <TabStateChip state={tab.state} />
            <span className="xsmall muted">Authorization</span> <Id value={tab.authorizationId} />
            {tab.captureId ? (
              <>
                <span className="xsmall muted">Capture</span> <Id value={tab.captureId} />
              </>
            ) : tab.state === 'voided' ? (
              <span className="xsmall muted">Voided — nothing captured</span>
            ) : null}
            {tab.captureId && <WebhookBadge at={tab.captureWebhookAt} />}
          </div>
          {receipt.disputeOpen && (
            <Banner tone="warn" icon="shield">
              <strong>A PayPal dispute is open on this tab.</strong> Contests and refunds here wait until PayPal resolves it.
            </Banner>
          )}
          <ol className="receipt__lines">
            {receipt.lines.map((l) => (
              <Line key={l.backingId} line={l} token={token} canContest={canContest && !receipt.disputeOpen} onChanged={load} ctx={{ roomStatus: receipt.roomStatus ?? null, tabState: tab.state }} />
            ))}
          </ol>
          <div className="receipt__foot">
            <VerifyBox token={token} />
            <p className="xsmall muted">
              {receipt.contestDeadline ? (canContest ? `The contest window closes ${timeUntil(receipt.contestDeadline)}.` : 'The contest window has closed.') : null} Quotes are cut by code
              from the creator's transcript; Claude never writes them. Sandbox test money only.
            </p>
          </div>
        </div>
      </main>
    </div>
  )
}
