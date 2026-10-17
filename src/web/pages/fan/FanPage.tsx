// Fan page (mobile-first). Identity lives in the URL (?t=TOKEN) so a refresh or a shared phone keeps it.
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import type { FanSelfView, PublicConfig, QuestionView, RoomEvent, RoomView, TabView } from '../../../shared/types.js'
import { Icon } from '../../components/Icon.js'
import { Logo } from '../../components/Logo.js'
import { Quote, QuestionCard } from '../../components/QuestionCard.js'
import { Badge, StateChip } from '../../components/StateChip.js'
import { Banner, Empty, Id, Seg, useAction } from '../../components/ui.js'
import { api, toApiError } from '../../lib/api.js'
import { backBlock, canAsk, cardStatus, isLateBacking, myBacking, rankQuestions, type BackingIn } from '../../lib/cardState.js'
import { applyFanEvent, type FanState } from '../../lib/events.js'
import { parseRelayMessage } from '../../lib/relay.js'
import { isQuoteTruncated, money, plural } from '../../lib/format.js'
import { friendlyError, intakeMessage } from '../../lib/messages.js'
import { similarQuestion } from '../../lib/similarity.js'
import { useLiveState, type ExternalSource } from '../../lib/useLiveState.js'
import { paths } from '../../lib/url.js'
import { PageError, PageLoading } from '../Fallbacks.js'
import { TabStateChip } from '../../components/Status.js'
import '../../styles/fan.css'

const Checkout = lazy(() => import('./Checkout.js'))

const MAX_QUESTION = 280

function usePublicConfig() {
  const [config, setConfig] = useState<PublicConfig | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api.config().then(setConfig, (e) => setError(friendlyError(toApiError(e))))
  }, [])
  return { config, error }
}

function HoldExplainer({ compact }: { compact?: boolean }) {
  return (
    <div className="explainer">
      <h2 className="display explainer__title">This is a hold, not a charge.</h2>
      {!compact && (
        <ul className="explainer__list">
          <li>
            <Icon name="card" /> PayPal holds the amount you pick. Nothing leaves your account yet.
          </li>
          <li>
            <Icon name="lock" /> You pay only for questions the creator answers on stream, quoted word for word.
          </li>
          <li>
            <Icon name="slash" /> Everything else is released when the stream ends. One charge at most.
          </li>
        </ul>
      )}
    </div>
  )
}

function FanHeader({ room, me, embed }: { room: RoomView; me: FanSelfView | null; embed: boolean }) {
  const live = room.status === 'live'
  return (
    <header className="fan__bar">
      {!embed && <Logo small />}
      <div className="fan__title">
        <span className="fan__room">{room.title}</span>
        {me && <span className="xsmall muted">as {me.displayName}</span>}
      </div>
      <span className="spacer" />
      {live ? <span className="badge badge--live">LIVE</span> : <Badge tone="neutral">{room.status === 'draft' ? 'Not started' : 'Ended'}</Badge>}
      {!embed && (
        <Badge icon="shield" className="badge--sandbox">
          Sandbox
        </Badge>
      )}
    </header>
  )
}

function JoinView({ roomId, embed }: { roomId: string; embed: boolean }) {
  const [, setParams] = useSearchParams()
  const [room, setRoom] = useState<RoomView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const { busy, run } = useAction()

  useEffect(() => {
    const load = () => api.room(roomId).then(setRoom, (e) => setError(friendlyError(toApiError(e))))
    void load()
    const id = setInterval(() => document.visibilityState === 'visible' && void load(), 5000)
    return () => clearInterval(id)
  }, [roomId])

  const join = async (e: FormEvent) => {
    e.preventDefault()
    const displayName = name.trim()
    if (!displayName) return
    const r = await run('join', () => api.join(roomId, displayName))
    if (r) setParams((p) => ({ ...Object.fromEntries(p), t: r.fanToken }), { replace: true })
  }

  if (error && !room) return <PageError title="Room not found" detail={error} />
  if (!room) return <PageLoading />
  const closed = room.status !== 'live' && room.status !== 'draft'
  const questions = rankQuestions(room.questions).slice(0, 3)
  return (
    <div className={['fan', embed ? 'fan--embed' : ''].join(' ')}>
      <FanHeader room={room} me={null} embed={embed} />
      <main className="fan__main">
        <HoldExplainer />
        {closed ? (
          <Banner tone="info">This stream has ended. New tabs are closed.</Banner>
        ) : (
          <form className="join" onSubmit={join}>
            <label className="field">
              <span className="field__label">Your name on questions</span>
              <input className="input input--lg" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="e.g. Maya" autoComplete="nickname" required />
            </label>
            <button type="submit" className="btn btn--primary btn--lg btn--block" disabled={!name.trim() || busy === 'join'}>
              <Icon name={busy === 'join' ? 'spinner' : 'arrowRight'} />
              Join the stream
            </button>
            <p className="xsmall muted">Your link becomes your identity. Bookmark it to come back to your tab and receipt.</p>
          </form>
        )}
        <div className="fan__prices">
          <span>
            Ask <strong className="num">{money(room.prices.questionCents, { compact: true })}</strong>
          </span>
          <span>
            Back a question <strong className="num">{money(room.prices.metooCents, { compact: true })}</strong>
          </span>
          <span>Charged only if answered</span>
        </div>
        {questions.length > 0 && (
          <section className="stack gap-2" aria-label="Top questions">
            <h2 className="label">On the board</h2>
            {questions.map((q) => (
              <QuestionCard key={q.id} q={q} />
            ))}
          </section>
        )}
      </main>
    </div>
  )
}

function HoldStep({ roomId, fanToken, room, onTab }: { roomId: string; fanToken: string; room: RoomView; onTab: (t: TabView) => void }) {
  const { config, error } = usePublicConfig()
  const ceilings = room.prices.ceilingsCents.length ? room.prices.ceilingsCents : [1000, 2000, 4000]
  const [ceiling, setCeiling] = useState<number>(ceilings[0]!)
  const [go, setGo] = useState(false)
  return (
    <section className="holdstep stack gap-4" aria-label="Open your tab">
      <HoldExplainer />
      <div className="field">
        <span className="field__label">Choose your hold</span>
        <div className="holdpick" role="radiogroup" aria-label="Hold amount">
          {ceilings.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={ceiling === c} className="holdpick__opt" onClick={() => setCeiling(c)} disabled={go}>
              <strong className="num">{money(c, { compact: true })}</strong>
              <span className="xsmall muted">{plural(Math.floor(c / room.prices.questionCents), 'question')}</span>
            </button>
          ))}
        </div>
        <span className="field__hint">One tab per stream, no top-ups. Asking reserves {money(room.prices.questionCents, { compact: true })}; backing reserves {money(room.prices.metooCents, { compact: true })}.</span>
      </div>
      {!go ? (
        <button type="button" className="btn btn--primary btn--lg btn--block" onClick={() => setGo(true)}>
          Continue to PayPal
          <Icon name="arrowRight" />
        </button>
      ) : error ? (
        <Banner tone="bad">{error}</Banner>
      ) : !config ? (
        <div className="skeleton" style={{ height: 120 }} />
      ) : (
        <Suspense fallback={<div className="skeleton" style={{ height: 220 }} />}>
          <Checkout roomId={roomId} fanToken={fanToken} ceilingCents={ceiling} config={config} onTab={onTab} />
          <button type="button" className="linklike small" onClick={() => setGo(false)}>
            Change the amount
          </button>
        </Suspense>
      )}
    </section>
  )
}

function MyTab({ me, roomStatus }: { me: FanSelfView; roomStatus: RoomView['status'] }) {
  const tab = me.tab!
  const free = Math.max(0, tab.ceilingCents - tab.reservedCents)
  const reservedPct = tab.ceilingCents ? Math.min(100, (tab.reservedCents / tab.ceilingCents) * 100) : 0
  const settled = tab.state === 'captured' || tab.state === 'voided'
  return (
    <section className="mytab" aria-label="Your tab">
      <div className="row">
        <h2 className="mytab__title">Your tab</h2>
        <TabStateChip state={tab.state} />
      </div>
      {settled ? (
        <div className="mytab__settled">
          <div>
            <span className="label">Charged</span>
            <strong>{money(tab.capturedCents)}</strong>
          </div>
          <div>
            <span className="label">Released</span>
            <strong>{money(tab.releasedCents)}</strong>
          </div>
          {tab.refundedCents > 0 && (
            <div>
              <span className="label">Refunded</span>
              <strong>{money(tab.refundedCents)}</strong>
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="mytab__nums num">
            <span>
              <strong>{money(tab.ceilingCents, { compact: true })}</strong> hold
            </span>
            <span>
              <strong>{money(tab.reservedCents, { compact: true })}</strong> reserved
            </span>
            <span>
              <strong>{money(free, { compact: true })}</strong> free
            </span>
          </div>
          <div className="meter" role="img" aria-label={`${money(tab.reservedCents)} of ${money(tab.ceilingCents)} reserved`}>
            <span className="meter__reserved" style={{ width: `${reservedPct}%` }} />
          </div>
          <p className="xsmall muted">
            Reserved is not charged. {roomStatus === 'live' ? 'You pay only for answered questions when the stream ends.' : 'The creator is reviewing answers now.'}
          </p>
        </>
      )}
      <div className="row xsmall muted">
        <span>Authorization</span>
        <Id value={tab.authorizationId} />
        {tab.captureId && (
          <>
            <span>Capture</span>
            <Id value={tab.captureId} />
          </>
        )}
      </div>
      {tab.receiptToken && (
        <Link className="btn btn--primary btn--block" to={paths.receipt(tab.receiptToken)}>
          <Icon name="receipt" />
          Open your receipt
        </Link>
      )}
    </section>
  )
}

function Declined({ tab, roomId }: { tab: TabView; roomId: string }) {
  return (
    <section className="stack gap-3" aria-label="Tab declined">
      <StateChip icon="xCircle" tone="bad" label="Declined by the processor (sandbox test) — not charged" large />
      <p className="small">
        PayPal returned the order as completed, but the authorization itself was denied, so no hold exists and nothing was charged.
        {tab.declineReason && <> Reason: <span className="mono">{tab.declineReason}</span>.</>}
      </p>
      <Link className="btn" to={paths.fan(roomId)}>
        Join again with another name
      </Link>
    </section>
  )
}

/** Big flip card when a question this fan backed gets answered. */
function LockMoment({ room, me }: { room: RoomView; me: FanSelfView }) {
  const mine = new Map(me.backings.map((b) => [b.questionId, b]))
  const locked = room.questions.filter((q) => (q.state === 'locked' || q.state === 'verifying') && mine.has(q.id) && q.quote && !isLateBacking(mine.get(q.id)! as BackingIn, q))
  const latest = locked.sort((a, b) => (b.quoteAtMs ?? 0) - (a.quoteAtMs ?? 0))[0]
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  if (!latest || dismissed.has(`${latest.id}:${latest.state}`)) return null
  const b = mine.get(latest.id)!
  const st = cardStatus(latest, { myCents: b.amountCents })
  return (
    <section key={`${latest.id}:${latest.state}`} className="moment" data-tone={st.tone} aria-live="polite">
      <div className="row nowrap">
        <StateChip icon={st.icon} label={st.label} tone={st.tone} large pop />
        <span className="spacer" />
        <button type="button" className="btn btn--ghost btn--sm btn--icon" aria-label="Dismiss" onClick={() => setDismissed((s) => new Set(s).add(`${latest.id}:${latest.state}`))}>
          <Icon name="x" />
        </button>
      </div>
      <p className="moment__q">
        <span className="qcard__num">#{latest.number}</span> {latest.text}
      </p>
      <Quote text={latest.quote!} atMs={latest.quoteAtMs} source={latest.quoteSource} creatorConfirmed={latest.creatorConfirmed} truncated={isQuoteTruncated(latest)} tone={st.tone} />
      <p className="xsmall muted">{latest.state === 'locked' ? 'Still a hold: the creator approves at the end, then PayPal captures once.' : 'Claude Opus is double-checking this quote.'}</p>
    </section>
  )
}

function FullNote({ free, prices }: { free: number; prices: RoomView['prices'] }) {
  return (
    <Banner tone="info">
      {free >= prices.metooCents
        ? `Asking needs ${money(prices.questionCents, { compact: true })} and ${money(free, { compact: true })} of your hold is free. You can still back a question for ${money(prices.metooCents, { compact: true })}.`
        : 'Your hold is fully reserved. You still pay only for questions that get answered.'}
    </Banner>
  )
}

function AskForm({ roomId, fanToken, room, me, onDone }: { roomId: string; fanToken: string; room: RoomView; me: FanSelfView; onDone: () => void }) {
  const [text, setText] = useState('')
  const [reject, setReject] = useState<string | null>(null)
  const [created, setCreated] = useState<QuestionView | null>(null)
  const [serverSimilar, setServerSimilar] = useState<number | null>(null)
  const { busy, run } = useAction()
  const open = room.questions.filter((q) => q.state === 'open' || q.state === 'deflected')
  const hint = text.trim().length > 8 ? similarQuestion(text, open) : null
  const hinted = hint ? open.find((q) => q.number === hint.number) ?? null : null
  const allowed = canAsk(me, room.prices)
  const byNumber = (n: number | null | undefined) => (n == null ? null : room.questions.find((q) => q.number === n) ?? null)
  const suggestion = byNumber(serverSimilar) ?? byNumber(created?.similarTo) ?? hinted

  // First try asks the server to check for a near-duplicate (Claude intake). "Ask anyway" skips the check.
  const submit = async (checkSimilar: boolean) => {
    const t = text.trim()
    if (!t) return
    setReject(null)
    const q = await run(
      'ask',
      () => api.ask(roomId, fanToken, t, checkSimilar),
      (err) => {
        const e = toApiError(err)
        if (e.code === 'similar_question' && typeof e.details.similarTo === 'number') {
          setServerSimilar(e.details.similarTo)
          return true
        }
        const msg = intakeMessage(e)
        if (msg) setReject(msg)
        return !!msg
      },
    )
    if (q) {
      setText('')
      setServerSimilar(null)
      setCreated(q)
      onDone()
    }
  }
  const ask = (e: FormEvent) => {
    e.preventDefault()
    void submit(true)
  }

  const back = async (q: QuestionView) => {
    const ok = await run(`back:${q.id}`, () => api.back(q.id, fanToken))
    if (ok !== undefined) {
      setText('')
      setCreated(null)
      setServerSimilar(null)
      onDone()
    }
  }
  const sugBlock = suggestion ? backBlock(suggestion, me, room.prices) : 'state'

  return (
    <form className="ask" onSubmit={ask}>
      <label className="field">
        <span className="field__label">Ask the creator</span>
        <textarea
          className="input"
          value={text}
          onChange={(e) => {
            setText(e.target.value.slice(0, MAX_QUESTION))
            setReject(null)
            setCreated(null)
            setServerSimilar(null)
          }}
          placeholder="One clear question, like you'd ask in person"
          rows={3}
          disabled={!allowed}
        />
        <span className="field__hint num">
          {text.length}/{MAX_QUESTION} · reserves {money(room.prices.questionCents, { compact: true })} of your hold, charged only if answered
        </span>
      </label>
      {suggestion && sugBlock === null && (
        <div className="similar" role="status">
          <Icon name="info" />
          <span>
            {created ? 'Posted. It looks' : 'Looks'} similar to <strong>#{suggestion.number}</strong> "{suggestion.text}" — back it instead?
          </span>
          <button type="button" className="btn btn--sm" onClick={() => back(suggestion)} disabled={busy !== null}>
            <Icon name="plus" />
            Me too · {money(room.prices.metooCents, { compact: true })}
          </button>
          {serverSimilar !== null && (
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => void submit(false)} disabled={busy !== null}>
              Ask anyway
            </button>
          )}
        </div>
      )}
      {reject && <Banner tone="warn">{reject}</Banner>}
      {!allowed && me.tab?.state === 'held' && <FullNote free={Math.max(0, me.tab.ceilingCents - me.tab.reservedCents)} prices={room.prices} />}
      <button type="submit" className="btn btn--primary btn--block" disabled={!allowed || !text.trim() || busy !== null}>
        <Icon name={busy === 'ask' ? 'spinner' : 'send'} />
        {busy === 'ask' ? 'Checking your question…' : `Ask · ${money(room.prices.questionCents, { compact: true })} from your hold`}
      </button>
    </form>
  )
}

function FanQuestions({ room, me, fanToken, onDone }: { room: RoomView; me: FanSelfView; fanToken: string; onDone: () => void }) {
  const { busy, run } = useAction()
  const [filter, setFilter] = useState<'all' | 'mine'>('all')
  const mineIds = new Set(me.backings.map((b) => b.questionId))
  const ranked = rankQuestions(room.questions).filter((q) => filter === 'all' || mineIds.has(q.id))
  return (
    <section className="stack gap-3" aria-label="Questions">
      <div className="row">
        <h2 className="label">Questions</h2>
        <span className="spacer" />
        <Seg
          label="Filter questions"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All', count: rankQuestions(room.questions).length },
            { value: 'mine', label: 'Mine', count: mineIds.size },
          ]}
        />
      </div>
      {ranked.length === 0 ? (
        <Empty icon="users">{filter === 'mine' ? 'You have not asked or backed anything yet.' : 'No questions yet. Ask the first one.'}</Empty>
      ) : (
        <ol className="qlist">
          {ranked.map((q) => {
            const b = myBacking(q.id, me.backings)
            const block = backBlock(q, me, room.prices)
            return (
              <li key={q.id}>
                <QuestionCard
                  q={q}
                  myCents={b?.amountCents ?? null}
                  late={b ? isLateBacking(b as BackingIn, q) : false}
                  mine={b ? (b.kind === 'ask' ? 'asked' : 'backed') : null}
                  motion={b ? 'flip' : 'lock'}
                  actions={
                    block === null ? (
                      <button type="button" className="btn btn--sm" onClick={() => run(`back:${q.id}`, () => api.back(q.id, fanToken)).then((r) => r !== undefined && onDone())} disabled={busy !== null}>
                        <Icon name={busy === `back:${q.id}` ? 'spinner' : 'plus'} />
                        Me too · {money(room.prices.metooCents, { compact: true })}
                      </button>
                    ) : block === 'full' ? (
                      <span className="xsmall muted">Your hold is full</span>
                    ) : block === 'no_tab' && room.status === 'live' ? (
                      <span className="xsmall muted">Open a tab to back this</span>
                    ) : null
                  }
                />
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}

/**
 * In the presentation strip the parent page holds the only SSE stream and relays this fan's events with
 * postMessage, so a phone opens no EventSource of its own. Only same-origin messages from the parent count.
 */
function useParentRelay(enabled: boolean): ExternalSource | undefined {
  return useMemo(() => {
    if (!enabled || typeof window === 'undefined' || window.parent === window) return undefined
    return (onEvent, onResync) => {
      const onMessage = (e: MessageEvent) => {
        if (e.origin !== window.location.origin || e.source !== window.parent) return
        const m = parseRelayMessage(e.data)
        if (!m) return
        if (m.kind === 'event') onEvent(m.event)
        else if (m.kind === 'resync') onResync()
      }
      window.addEventListener('message', onMessage)
      return () => window.removeEventListener('message', onMessage)
    }
  }, [enabled])
}

function FanScreen({ roomId, fanToken, embed, relay }: { roomId: string; fanToken: string; embed: boolean; relay: boolean }) {
  const external = useParentRelay(embed && relay)
  const load = useCallback(async (): Promise<FanState> => {
    const [room, me] = await Promise.all([api.room(roomId), api.me(roomId, fanToken)])
    return { room, me }
  }, [roomId, fanToken])
  // Backings made elsewhere (another device, or the demo director for bot fans) only reach this page as
  // public counts, so a debounced reload refreshes the fan's own record.
  const reloadSoon = useRef<() => void>(() => {})
  const onEvent = useCallback((ev: RoomEvent) => {
    if (ev.type === 'tab.updated' || ev.type === 'backing.created' || ev.type === 'question.created') reloadSoon.current()
  }, [])
  const live = useLiveState<FanState>({ roomId, auth: { fan: fanToken }, load, apply: applyFanEvent, onEvent, external })
  const { data, error, reload, setData } = live
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined
    reloadSoon.current = () => {
      clearTimeout(t)
      t = setTimeout(() => void reload(), 350)
    }
    return () => clearTimeout(t)
  }, [reload])
  const status = data?.room.status
  const prevStatus = useRef(status)
  useEffect(() => {
    // Settlement fills in capture IDs and the receipt link on the fan's own record.
    if (prevStatus.current && status !== prevStatus.current && (status === 'settled' || status === 'voided' || status === 'ended')) void reload()
    prevStatus.current = status
  }, [status, reload])

  const onTab = useCallback((tab: TabView) => setData((s) => ({ ...s, me: s.me ? { ...s.me, tab } : s.me })), [setData])
  const refresh = useCallback(() => void reload(), [reload])

  const content = useMemo(() => {
    if (!data) return null
    const { room, me } = data
    if (!me) return null
    const tab = me.tab
    const open = room.status === 'live' || room.status === 'draft'
    return (
      <>
        <LockMoment room={room} me={me} />
        {!tab || tab.state === 'opening' ? (
          open ? (
            <HoldStep roomId={roomId} fanToken={fanToken} room={room} onTab={onTab} />
          ) : (
            <Banner tone="info">This stream has ended before you opened a tab. Nothing was held or charged.</Banner>
          )
        ) : tab.state === 'declined' ? (
          <Declined tab={tab} roomId={roomId} />
        ) : (
          <MyTab me={me} roomStatus={room.status} />
        )}
        {/* In the presentation strip the board comes first, so the answer moment is on screen. */}
        {embed && <FanQuestions room={room} me={me} fanToken={fanToken} onDone={refresh} />}
        {tab?.state === 'held' && room.status === 'live' && <AskForm roomId={roomId} fanToken={fanToken} room={room} me={me} onDone={refresh} />}
        {!embed && <FanQuestions room={room} me={me} fanToken={fanToken} onDone={refresh} />}
      </>
    )
  }, [data, roomId, fanToken, onTab, refresh, embed])

  if (!data) {
    if (error)
      return (
        <PageError
          title={error.status === 401 || error.status === 403 || error.status === 404 ? 'This fan link is not valid' : 'Could not load the stream'}
          detail={friendlyError(error)}
          action={
            <Link className="btn btn--primary" to={paths.fan(roomId)}>
              Join again
            </Link>
          }
        />
      )
    return <PageLoading />
  }

  return (
    <div className={['fan', embed ? 'fan--embed' : ''].join(' ')}>
      <FanHeader room={data.room} me={data.me} embed={embed} />
      <main className="fan__main">{content}</main>
      {!embed && (
        <footer className="fan__foot xsmall muted">
          Sandbox demo · PayPal holds, not charges · <Link to="/">About AnswerTab</Link>
        </footer>
      )}
    </div>
  )
}

export default function FanPage() {
  const { room = '' } = useParams()
  const [params] = useSearchParams()
  const token = params.get('t')
  const embed = params.get('embed') === '1'
  const relay = params.get('relay') === '1'
  useEffect(() => {
    document.title = 'AnswerTab · Fan'
  }, [])
  return token ? <FanScreen key={token} roomId={room} fanToken={token} embed={embed} relay={relay} /> : <JoinView roomId={room} embed={embed} />
}
