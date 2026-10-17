// Presentation layout for the video: two console panes plus a fan strip of the three bot fans' phones,
// each a live fan page in an iframe. The page holds the one creator SSE stream and relays each event to the
// phones (postMessage, same origin), so the layout uses one connection and all three flip together.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom'
import type { RoomEvent } from '../../shared/types.js'
import { Icon } from '../components/Icon.js'
import { RecordedRun } from '../components/RecordedRun.js'
import { Banner, CopyField, Empty, Seg, useNow, useToast } from '../components/ui.js'
import { api, type RecordedRun as Run } from '../lib/api.js'
import { judgeChecklist } from '../lib/checklist.js'
import { plural } from '../lib/format.js'
import { friendlyError } from '../lib/messages.js'
import { RELAY_TAG, eventForFan, type RelayMessage } from '../lib/relay.js'
import { replayProgress } from '../lib/replay.js'
import { readDemoFans, takeCreatorToken, type StripFan } from '../lib/session.js'
import { paypalDegraded } from '../lib/statusChecks.js'
import { absolute, paths } from '../lib/url.js'
import { PageError, PageLoading } from './Fallbacks.js'
import { ConsoleHeader } from './console/ConsoleParts.js'
import { StageBody, stageOptions, usePointing, useStage, type StageTab } from './console/ConsolePage.js'
import { Checklist } from './console/Extras.js'
import { InputBar } from './console/InputBar.js'
import { ContestsPanel, DisputesPanel, LedgerPanel, PayoutPanel } from './console/MoneyPanels.js'
import { Transcript } from './console/Transcript.js'
import { useConsole, type ConsoleModel } from './console/useConsole.js'
import '../styles/console.css'
import '../styles/demo.css'

const PHONE_W = 340
const PHONE_H = 720
const GAP = 16
const REVIEW_STATUSES = new Set(['ended', 'settling', 'settled', 'voided'])

type Pane = StageTab | 'ledger' | 'after'

function useScale(): [string, (s: string) => void] {
  const [scale, setScale] = useState(() => document.documentElement.dataset.scale ?? '100')
  useEffect(() => {
    if (scale === '100') delete document.documentElement.dataset.scale
    else document.documentElement.dataset.scale = scale
    const url = new URL(window.location.href)
    if (scale === '100') url.searchParams.delete('scale')
    else url.searchParams.set('scale', scale)
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
  }, [scale])
  return [scale, setScale]
}

/** postMessage to each phone, filtered to what that fan's own stream would carry. */
function usePhoneRelay(fans: StripFan[]) {
  const frames = useRef(new Map<string, HTMLIFrameElement>())
  const post = useCallback((frame: HTMLIFrameElement, msg: RelayMessage) => {
    frame.contentWindow?.postMessage(msg, window.location.origin)
  }, [])
  const relay = useCallback(
    (ev: RoomEvent) => {
      for (const f of fans) {
        const frame = frames.current.get(f.fanId)
        const out = frame && eventForFan(ev, f.fanId)
        if (frame && out) post(frame, { tag: RELAY_TAG, kind: 'event', event: out })
      }
    },
    [fans, post],
  )
  const resync = useCallback(() => {
    for (const frame of frames.current.values()) post(frame, { tag: RELAY_TAG, kind: 'resync' })
  }, [post])
  const register = useCallback((fanId: string, el: HTMLIFrameElement | null) => {
    if (el) frames.current.set(fanId, el)
    else frames.current.delete(fanId)
  }, [])
  return { relay, resync, register }
}

function FanStrip({ roomId, fans, register }: { roomId: string; fans: StripFan[]; register: (fanId: string, el: HTMLIFrameElement | null) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [k, setK] = useState(0.8)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = () => {
      const n = Math.max(1, fans.length)
      const w = (el.clientWidth - GAP * (n - 1)) / n
      const h = el.clientHeight - 36
      setK(Math.max(0.4, Math.min(1.25, w / PHONE_W, h > 200 ? h / PHONE_H : Infinity)))
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [fans.length])

  if (fans.length === 0)
    return (
      <div className="strip strip--empty" ref={ref}>
        <Empty icon="users">The bot fans' phones appear here when this page is opened from "Start a demo room" in this tab.</Empty>
      </div>
    )
  // The phones are laid out at a fixed 340 px and enlarged with a transform, so the page's presentation scale
  // is not passed in: a 130% root font inside a 340 px frame would clip every chip and amount.
  return (
    <div className="strip" ref={ref} aria-label="Fan phones">
      {fans.map((f) => (
        <figure key={f.fanId} className="phone" style={{ width: PHONE_W * k }}>
          <div className="phone__screen" style={{ width: PHONE_W * k, height: PHONE_H * k }}>
            <iframe
              ref={(el) => register(f.fanId, el)}
              title={`Fan phone: ${f.displayName}`}
              src={paths.fan(roomId, f.fanToken, { embed: '1', relay: '1' })}
              allow="payment"
              style={{ width: PHONE_W, height: PHONE_H, transform: `scale(${k})` }}
            />
          </div>
          <figcaption className="phone__name">{f.displayName}</figcaption>
        </figure>
      ))}
    </div>
  )
}

/** "Try it yourself": the judge checklist plus the fan link, QR and the full console, in a drawer over the strip. */
function TryPanel({
  model,
  open,
  onClose,
  onRecord,
  ticked,
  setTicked,
}: {
  model: ConsoleModel
  open: boolean
  onClose: () => void
  onRecord: () => void
  ticked: Set<string>
  setTicked: (fn: (s: Set<string>) => Set<string>) => void
}) {
  const view = model.view!
  const roomId = view.room.id
  const fanLink = absolute(paths.fan(roomId), window.location.origin)
  return (
    <aside className="trypanel" id="try-panel" aria-labelledby="try-panel-title" hidden={!open}>
      <div className="trypanel__head">
        <Icon name="checkCircle" />
        <h2 id="try-panel-title" className="panel__title">
          Try it yourself
        </h2>
        <span className="spacer" />
        <button type="button" className="btn btn--ghost btn--sm" onClick={onRecord} title="Hides this panel and its button; remove ?record=1 from the address to bring them back">
          Hide for recording
        </button>
        <button type="button" className="btn btn--ghost btn--sm btn--icon" onClick={onClose} aria-label="Close the checklist">
          <Icon name="x" />
        </button>
      </div>
      <div className="trypanel__body">
        <section className="trypanel__fan" aria-label="Your own fan tab">
          <img src={api.qrUrl(roomId)} width={112} height={112} alt="QR code that opens the fan link" />
          <div className="stack gap-2" style={{ minWidth: 0, flex: 1 }}>
            <span className="field__label">Your fan link</span>
            <p className="xsmall muted">Scan with your phone, or open it in a new tab. Use the sandbox test card shown on the page.</p>
            <CopyField value={fanLink} label="fan link" />
            <a className="btn btn--sm" href={paths.fan(roomId)} target="_blank" rel="noopener">
              <Icon name="external" />
              Open fan page
            </a>
          </div>
        </section>
        <Checklist view={view} embedded ticked={ticked} setTicked={setTicked} />
        <Link className="btn btn--block" to={paths.console(roomId)}>
          <Icon name="external" />
          Full console: receipts, tabs and disputes
        </Link>
      </div>
    </aside>
  )
}

function useRecordedRun(): Run | null {
  const [run, setRun] = useState<Run | null>(null)
  useEffect(() => {
    api.statusReport().then(
      (r) => setRun(paypalDegraded(r.checks) ? r.lastPassedRun : null),
      () => setRun(null),
    )
  }, [])
  return run
}

function DemoScreen({ roomId, token }: { roomId: string; token: string }) {
  const fans = useMemo(() => readDemoFans(roomId).slice(0, 3), [roomId])
  const phones = usePhoneRelay(fans)
  const model = useConsole(roomId, token, { onEvent: phones.relay })
  const toast = useToast()
  const location = useLocation()
  const [params, setParams] = useSearchParams()
  const record = params.get('record') === '1'
  const [scale, setScale] = useScale()
  const [stage, setStage] = useStage(model)
  const [pane, setPane] = useState<Pane>('questions')
  const [localInterim, setLocalInterim] = useState<string | null>(null)
  const [micLive, setMicLive] = useState(false)
  const [tryOpen, setTryOpen] = useState(false)
  // Manual checklist ticks live here so the header counter and the drawer agree.
  const [ticked, setTicked] = useState<Set<string>>(() => new Set())
  const [transcriptOpen, setTranscriptOpen] = useState(true)
  const point = usePointing(model)
  const recorded = useRecordedRun()
  const now = useNow(5000)
  const status = model.view?.room.status
  const reviewing = !!status && REVIEW_STATUSES.has(status)

  useEffect(() => {
    document.title = 'AnswerTab · Presentation'
  }, [])
  useEffect(() => {
    const notice = (location.state as { notice?: unknown } | null)?.notice
    if (typeof notice === 'string') toast(notice, 'info')
    // Once, for the notice the landing page handed over.
  }, [])
  useEffect(() => {
    setPane((p) => (p === 'ledger' || p === 'after' ? p : stage))
  }, [stage])
  useEffect(() => {
    if (status === 'ended' || status === 'settled') setPane(status === 'ended' ? 'review' : 'results')
  }, [status])
  // After End the review needs the room: fold the transcript away (it can be opened again).
  useEffect(() => {
    setTranscriptOpen(!reviewing)
  }, [reviewing])

  // The phones load their own state; they only need a resync when the parent's stream comes back.
  const stream = model.live.stream
  const resyncPhones = phones.resync
  const wasOpen = useRef(false)
  useEffect(() => {
    if (stream !== 'open') return
    if (wasOpen.current) resyncPhones()
    wasOpen.current = true
  }, [stream, resyncPhones])

  const view = model.view
  const replay = view
    ? replayProgress({
        status: view.room.status,
        segments: view.segments,
        tabs: view.tabs,
        questions: view.room.questions,
        interim: !!model.serverInterim,
        clockMs: view.room.clockStartedAt ? now - Date.parse(view.room.clockStartedAt) : null,
      })
    : null
  // Open the checklist once, when the replay hands over to the judge.
  const autoOpened = useRef(false)
  useEffect(() => {
    if (record || autoOpened.current || replay?.phase !== 'done') return
    autoOpened.current = true
    setTryOpen(true)
  }, [replay?.phase, record])

  const { live } = model
  if (!view) return live.error ? <PageError title="Could not load the demo room" detail={friendlyError(live.error)} /> : <PageLoading />

  const options = [
    ...stageOptions(model),
    { value: 'ledger' as const, label: 'PayPal ledger', icon: 'bank', count: view.ledger.length },
    { value: 'after' as const, label: 'Contests & payout', icon: 'webhook' },
  ]
  const checklist = judgeChecklist(view, ticked)
  const done = checklist.filter((i) => i.done).length
  const lines = view.segments.filter((s) => s.final).length
  const setRecord = () => {
    setTryOpen(false)
    setParams((p) => ({ ...Object.fromEntries(p), record: '1' }), { replace: true })
  }

  return (
    <div className="demo">
      <ConsoleHeader
        model={model}
        micLive={micLive}
        extra={
          <>
            <Seg
              label="Presentation scale"
              value={scale}
              onChange={setScale}
              options={[
                { value: '100', label: '100%' },
                { value: '130', label: '130%' },
                { value: '150', label: '150%' },
              ]}
            />
            {!record && (
              <button type="button" className={['btn', 'btn--sm', tryOpen ? '' : 'btn--ghost'].filter(Boolean).join(' ')} aria-expanded={tryOpen} aria-controls="try-panel" onClick={() => setTryOpen((o) => !o)}>
                <Icon name="checkCircle" />
                Try it<span className="demo__wide"> yourself</span>
                <span className="count num">
                  {done}/{checklist.length}
                </span>
              </button>
            )}
            <Link className="btn btn--ghost btn--sm" to={paths.console(roomId)}>
              <Icon name="external" />
              Full console
            </Link>
          </>
        }
      />
      {recorded && (
        <div className="demo__alert">
          <Banner tone="warn">
            <strong>The PayPal sandbox is failing checks.</strong> Live holds may not go through.{' '}
            <details className="demo__recorded">
              <summary>Show the last recorded run's PayPal IDs</summary>
              <RecordedRun run={recorded} compact />
            </details>
          </Banner>
        </div>
      )}
      <main className="demo__grid">
        <div className={['demo__console', transcriptOpen ? '' : 'is-folded'].filter(Boolean).join(' ')}>
          <section className="panel demo__pane demo__pane--transcript" aria-label="Transcript">
            {transcriptOpen ? (
              <>
                {reviewing && (
                  <div className="demo__fold">
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => setTranscriptOpen(false)} aria-expanded="true">
                      <Icon name="chevronDown" />
                      Fold the transcript
                    </button>
                  </div>
                )}
                <Transcript
                  model={model}
                  localInterim={localInterim}
                  pointing={point.pointing}
                  onPointDone={point.done}
                  large
                  footer={<InputBar model={model} onInterim={setLocalInterim} onLive={setMicLive} compact />}
                />
              </>
            ) : (
              <button type="button" className="demo__folded" onClick={() => setTranscriptOpen(true)} aria-expanded="false">
                <Icon name="mic" />
                <span className="panel__title">Transcript</span>
                <span className="small muted num">{plural(lines, 'line')}</span>
                <span className="spacer" />
                <span className="small">Show</span>
                <Icon name="chevronRight" />
              </button>
            )}
          </section>
          <section className="panel demo__pane demo__pane--stage">
            <header className="panel__head">
              <Seg
                label="Stage"
                value={pane}
                onChange={(v: Pane) => {
                  setPane(v)
                  if (v !== 'ledger' && v !== 'after') setStage(v)
                }}
                options={options}
              />
            </header>
            <div className="panel__body demo__stagebody">
              {pane === 'ledger' ? (
                <LedgerPanel model={model} />
              ) : pane === 'after' ? (
                <div className="stack gap-5">
                  <ContestsPanel model={model} />
                  <PayoutPanel model={model} />
                  {(view.disputes?.length ?? 0) > 0 && <DisputesPanel model={model} />}
                </div>
              ) : (
                <StageBody model={model} stage={pane} onPoint={point.start} large />
              )}
            </div>
          </section>
        </div>
        <div className="demo__side">
          <FanStrip roomId={roomId} fans={fans} register={phones.register} />
          {!record && <TryPanel model={model} open={tryOpen} onClose={() => setTryOpen(false)} onRecord={setRecord} ticked={ticked} setTicked={setTicked} />}
        </div>
      </main>
    </div>
  )
}

export default function DemoPage() {
  const { room = '' } = useParams()
  const [token] = useState(() => takeCreatorToken(room))
  if (!token)
    return (
      <PageError
        title="Open this from Start a demo room"
        detail="The presentation layout needs the room's console key, which only lives in the tab that created the room."
        action={
          <Link className="btn btn--primary" to="/">
            Start a demo room
          </Link>
        }
      />
    )
  return <DemoScreen roomId={room} token={token} />
}
