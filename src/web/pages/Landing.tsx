import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { QuestionState, QuestionView, StatusCheck } from '../../shared/types.js'
import { Icon } from '../components/Icon.js'
import { Logo } from '../components/Logo.js'
import { QuestionCard } from '../components/QuestionCard.js'
import { RecordedRun } from '../components/RecordedRun.js'
import { Badge } from '../components/StateChip.js'
import { Banner } from '../components/ui.js'
import { api, toApiError, type RecordedRun as Run } from '../lib/api.js'
import { money } from '../lib/format.js'
import { friendlyError } from '../lib/messages.js'
import { checkLabel, landingAlert } from '../lib/statusChecks.js'
import { rememberCreatorToken, rememberDemo } from '../lib/session.js'
import { paths, takeJudgeCode } from '../lib/url.js'
import '../styles/landing.css'

const SAMPLE: QuestionView = {
  id: 'sample-1',
  number: 1,
  text: 'How should I split a big API project into folders?',
  askerName: 'Maya',
  state: 'open',
  backers: 3,
  backedCents: 1200,
  similarTo: null,
  askedAtMs: 74_000,
  quote: 'one router file per feature, shared code in a core package',
  quoteAtMs: 141_000,
  quoteSource: 'spoken',
  creatorConfirmed: false,
  confidence: 0.93,
  rating: null,
}

// The hero card walks through the real states: asked, deflected, verified, locked.
const SEQUENCE: { state: QuestionState; ms: number }[] = [
  { state: 'open', ms: 1800 },
  { state: 'deflected', ms: 2200 },
  { state: 'verifying', ms: 1300 },
  { state: 'locked', ms: 4200 },
]

function useHeroState(): QuestionState {
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const [i, setI] = useState(reduced ? 3 : 0)
  useEffect(() => {
    if (reduced) return
    const t = setTimeout(() => setI((n) => (n + 1) % SEQUENCE.length), SEQUENCE[i]!.ms)
    return () => clearTimeout(t)
  }, [i, reduced])
  return SEQUENCE[i]!.state
}

function HeroVisual() {
  const state = useHeroState()
  const locked = state === 'locked'
  const fans = [
    { name: 'Maya', cents: 600, role: 'asked' },
    { name: 'Theo', cents: 300, role: 'me too' },
    { name: 'Ana', cents: 300, role: 'me too' },
  ]
  return (
    <figure className="hero-visual" aria-label="Example: one spoken answer locks three fans' holds">
      <div className="hero-visual__bar">
        <span className="badge badge--live">LIVE</span>
        <span className="small muted">Office hours · coding Q&amp;A</span>
      </div>
      <QuestionCard q={{ ...SAMPLE, state }} />
      <div className="hero-fans" aria-hidden="true">
        {fans.map((f) => (
          <div key={f.name} className={['hero-fan', locked ? 'is-locked' : ''].join(' ')}>
            <span className="hero-fan__name">{f.name}</span>
            <span className="hero-fan__state">
              <Icon name={locked ? 'lock' : 'card'} />
              <span className="num">{locked ? `${money(f.cents, { compact: true })} locked` : `${money(1000, { compact: true })} hold`}</span>
            </span>
          </div>
        ))}
      </div>
      <figcaption className="xsmall muted">One sentence, three fans' holds. The quote is cut from the transcript by code.</figcaption>
    </figure>
  )
}

/** "All checks passing" only when every check passes; otherwise a neutral link (the banner names what matters). */
function StatusLine({ checks }: { checks: StatusCheck[] | null }) {
  if (!checks || checks.length === 0) return null
  if (checks.every((c) => c.ok))
    return (
      <Link to="/status" className="status-pill" data-tone="ok">
        <Icon name="checkCircle" />
        All checks passing
      </Link>
    )
  return (
    <Link to="/status" className="status-pill" data-tone="neutral">
      <Icon name="gauge" />
      Status
    </Link>
  )
}

export function Landing() {
  const nav = useNavigate()
  const [checks, setChecks] = useState<StatusCheck[] | null>(null)
  const [lastRun, setLastRun] = useState<Run | null>(null)
  // `?code=` from a judge link: read once, then dropped from the address bar so it stays out of screenshots.
  const [link] = useState(() => (typeof window === 'undefined' ? { code: '', cleaned: null } : takeJudgeCode(window.location.href)))
  const [code, setCode] = useState(link.code)
  // A judge link (?code=) shows the field already filled, so one click on Start uses the judges' pool.
  const [prefilled] = useState(code !== '')
  const [showCode, setShowCode] = useState(prefilled)
  const [busy, setBusy] = useState<'demo' | 'room' | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (link.cleaned !== null) nav(link.cleaned, { replace: true })
  }, [link, nav])

  useEffect(() => {
    api.statusReport().then(
      (r) => {
        setChecks(r.checks)
        setLastRun(r.lastPassedRun)
      },
      () => setChecks(null),
    )
  }, [])

  const startDemo = async (e: FormEvent) => {
    e.preventDefault()
    setBusy('demo')
    setError(null)
    try {
      const judgeCode = code.trim() || undefined
      const r = await api.createDemo(judgeCode)
      rememberCreatorToken(r.roomId, r.creatorToken)
      rememberDemo(r.roomId, r.stripFans ?? [])
      // A code that the server did not accept lands the room in the public pool; say so on the next screen.
      const notice = judgeCode && r.pool === 'public' ? 'Judge code not recognized — this room uses the public pool and its shared Claude budget.' : null
      nav(paths.demo(r.roomId), notice ? { state: { notice } } : undefined)
    } catch (err) {
      setError(friendlyError(toApiError(err)))
      setBusy(null)
    }
  }

  const startRoom = async () => {
    setBusy('room')
    setError(null)
    try {
      const r = await api.createRoom({ kind: 'public', title: 'Office hours' })
      rememberCreatorToken(r.roomId, r.creatorToken)
      nav(paths.console(r.roomId))
    } catch (err) {
      setError(friendlyError(toApiError(err)))
      setBusy(null)
    }
  }

  // Only failures a judge would hit raise the banner; webhooks and a stale synthetic run stay on /status.
  const alert = landingAlert(checks, lastRun !== null)

  return (
    <div className="landing">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="landing__bar">
        <Logo />
        <span className="spacer" />
        <StatusLine checks={checks} />
        <Badge icon="shield" className="badge--sandbox">
          Sandbox
        </Badge>
      </header>

      <main id="main" className="landing__main">
        {alert.failing.length > 0 && (
          <div className="landing__alert">
            <Banner tone="warn">
              <strong>Some services are degraded:</strong> {alert.failing.map((c) => checkLabel(c.name)).join(', ')}. <Link to="/status">See status</Link>
            </Banner>
            {alert.recorded && lastRun && <RecordedRun run={lastRun} cause={alert.recorded} />}
          </div>
        )}

        <section className="hero">
          <div className="hero__copy">
            <p className="label hero__kicker">Live Q&amp;A on PayPal</p>
            <h1 className="display hero__title">
              Ask live.
              <br />
              Pay only for answers.
            </h1>
            <p className="hero__lede">
              Fans open one PayPal hold per stream. When the creator answers on air, Claude matches the words to the question and the
              exact quote is cut from the transcript. Each fan is charged once, only for answered questions. The rest of the hold is
              released.
            </p>

            <form className="hero__cta" onSubmit={startDemo}>
              <div className="row gap-3">
                <button type="submit" className="btn btn--primary btn--lg" disabled={busy !== null} aria-busy={busy === 'demo'}>
                  {busy === 'demo' ? <Icon name="spinner" /> : <Icon name="play" />}
                  {busy === 'demo' ? 'Opening room…' : 'Start a demo room'}
                </button>
                {!showCode ? (
                  <button type="button" className="linklike small" onClick={() => setShowCode(true)}>
                    I have a judge code
                  </button>
                ) : (
                  <label className="hero__code">
                    <span className="sr-only">Judge code (optional)</span>
                    <input
                      className="input"
                      // A code that arrived in the judge link stays masked, so screenshots and recordings never show it.
                      type={prefilled ? 'password' : 'text'}
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      placeholder="Judge code (optional)"
                      autoComplete="off"
                      spellCheck={false}
                      autoFocus={!prefilled}
                    />
                  </label>
                )}
              </div>
              <p className="small muted">
                A private room with three bot fans. They place their holds and ask first, so the replay starts about 15–20 seconds in and is done by about 40
                seconds. Then try it yourself.
              </p>
              <p className="small muted hero__access">
                <Icon name="shield" />
                <span>No login or keys needed; the judge code in the Devpost instructions reserves extra Claude budget.</span>
              </p>
              {error && <Banner tone="bad">{error}</Banner>}
            </form>
            <p className="small">
              <button type="button" className="linklike" onClick={startRoom} disabled={busy !== null}>
                {busy === 'room' ? 'Opening…' : 'Or open an empty room for your own stream'}
              </button>
            </p>
          </div>
          <HeroVisual />
        </section>

        <section className="steps" aria-labelledby="how">
          <h2 id="how" className="label">
            How it works
          </h2>
          <ol className="steps__list">
            <li>
              <span className="steps__n">1</span>
              <h3>Open a hold</h3>
              <p>A fan places a $10, $20 or $40 PayPal hold. It is an authorization, not a charge.</p>
            </li>
            <li>
              <span className="steps__n">2</span>
              <h3>Ask on stream</h3>
              <p>Ask for $6 or back someone's question for $3. The creator answers out loud; Claude checks the answer against the transcript.</p>
            </li>
            <li>
              <span className="steps__n">3</span>
              <h3>Pay for answers only</h3>
              <p>The creator approves. Each fan gets one capture for answered questions and the rest is released. Receipts quote the answer.</p>
            </li>
          </ol>
        </section>

        <section className="notes" aria-labelledby="honest">
          <h2 id="honest" className="label">
            Honest notes
          </h2>
          <ul className="notes__list">
            <li>
              <Icon name="shield" />
              <p>
                <strong>Sandbox only.</strong> PayPal sandbox accounts and published test cards. No real money moves.
              </p>
            </li>
            <li>
              <Icon name="mic" />
              <p>
                <strong>Mic mode uses Chrome's speech recognition,</strong> which sends the creator's audio to Google's speech service. Type and
                Replay send no audio.
              </p>
            </li>
            <li>
              <Icon name="spark" />
              <p>
                <strong>Claude receives text only</strong> — questions and transcript, never audio. It can release money on its own, but a charge
                needs a quote and the creator's approval.
              </p>
            </li>
            <li>
              <Icon name="clock" />
              <p>
                <strong>Deleted after 7 days.</strong> Rooms, fans and transcripts expire; unapproved holds are voided automatically.
              </p>
            </li>
          </ul>
        </section>
      </main>
      <footer className="landing__foot xsmall muted">
        <span>AnswerTab · a PayPal + Claude hackathon build · sandbox</span>
        <span className="spacer" />
        <Link to="/status">Service status</Link>
      </footer>
    </div>
  )
}
