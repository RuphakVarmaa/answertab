// Transcript inputs: Mic (Chrome Web Speech, continuous or push-to-talk), Type, and the demo Replay indicator.
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Icon } from '../../components/Icon.js'
import { Banner, Seg, useNow, useToast } from '../../components/ui.js'
import { toApiError } from '../../lib/api.js'
import { spaceStartsTalk } from '../../lib/keys.js'
import { medianMs } from '../../lib/lag.js'
import { friendlyError } from '../../lib/messages.js'
import { replayProgress } from '../../lib/replay.js'
import { SPEECH_LANGUAGES, SpeechInput, runMicTest, speechSupported, type SpeechState } from '../../lib/speech.js'
import type { ConsoleModel } from './useConsole.js'

const INTERIM_EVERY_MS = 700

/** Room settings: the speech-recognition language (POST /api/rooms/:id/settings). */
export function LanguageSelect({ model }: { model: ConsoleModel }) {
  const room = model.view!.room
  const editable = room.status === 'draft' || room.status === 'live'
  const known = SPEECH_LANGUAGES.some((l) => l.value === room.language)
  return (
    <label className="row gap-2 small langsel">
      <span className="muted">Speech language</span>
      <select
        className="input input--sm"
        aria-label="Speech language"
        value={room.language}
        disabled={!editable || model.busy === 'language'}
        onChange={(e) => void model.actions.setLanguage(e.target.value)}
        title={editable ? 'Chrome recognizes speech in this language' : 'Fixed once the stream ends'}
      >
        {!known && <option value={room.language}>{room.language}</option>}
        {SPEECH_LANGUAGES.map((l) => (
          <option key={l.value} value={l.value}>
            {l.label} · {l.value}
          </option>
        ))}
      </select>
    </label>
  )
}

function MicTest({ lang }: { lang: string }) {
  const [running, setRunning] = useState(false)
  const [level, setLevel] = useState(0)
  const [heard, setHeard] = useState('')
  const [result, setResult] = useState<string | null>(null)
  const run = async () => {
    setRunning(true)
    setResult(null)
    setHeard('')
    const r = await runMicTest(lang, 5000, setLevel, setHeard)
    setRunning(false)
    setResult(r.error ?? (r.heard ? `Mic works. Chrome heard: "${r.heard}"` : r.ok ? 'Mic picks up sound, but no words were recognized. Speak a little louder.' : 'No sound reached the mic.'))
  }
  return (
    <div className="mictest">
      <button type="button" className="btn btn--sm" onClick={run} disabled={running}>
        <Icon name={running ? 'spinner' : 'gauge'} />
        {running ? 'Testing… say something' : 'Test mic (5 s)'}
      </button>
      {running && (
        <span className="mictest__meter" aria-label="Input level">
          <span style={{ width: `${Math.round(level * 100)}%` }} />
        </span>
      )}
      {running && heard && <span className="small shimmer">{heard}</span>}
      {result && <span className="small" role="status">{result}</span>}
    </div>
  )
}

function MicControl({ model, onInterim, onLive }: { model: ConsoleModel; onInterim: (t: string | null) => void; onLive: (live: boolean) => void }) {
  const toast = useToast()
  const room = model.view!.room
  const enabled = room.status === 'live'
  const [state, setState] = useState<SpeechState>('off')
  const [mode, setMode] = useState<'continuous' | 'ptt' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lags, setLags] = useState<number[]>([])
  const engine = useRef<SpeechInput | null>(null)
  const pttButton = useRef<HTMLButtonElement>(null)
  const lastInterimSent = useRef(0)
  const seg = model.actions.segment

  const send = useCallback(
    (text: string, final: boolean, lagMs?: number) => {
      seg(text, final, 'spoken', lagMs).catch((e) => {
        if (final) toast(friendlyError(toApiError(e)), 'bad')
      })
    },
    [seg, toast],
  )
  const sendRef = useRef(send)
  sendRef.current = send

  useEffect(() => {
    const eng = new SpeechInput(room.language, {
      onInterim: (t) => {
        onInterim(t || null)
        const now = Date.now()
        if (t && now - lastInterimSent.current > INTERIM_EVERY_MS) {
          lastInterimSent.current = now
          sendRef.current(t, false)
        }
      },
      onFinal: (t, lag) => {
        onInterim(null)
        setLags((l) => [...l.slice(-4), lag])
        sendRef.current(t, true, lag)
      },
      onState: (s, msg) => {
        setState(s)
        if (s === 'error') setError(msg ?? 'Speech error')
        else if (s === 'listening') setError(null)
        if (s === 'off') setMode(null)
      },
    })
    engine.current = eng
    return () => {
      eng.dispose()
      engine.current = null
      onLive(false)
      onInterim(null)
    }
    // Recreate only when the room language changes; callbacks read fresh values through stable refs.
  }, [room.language])

  useEffect(() => onLive(state === 'listening' && mode !== null), [state, mode, onLive])

  const startPtt = useCallback(() => {
    if (!enabled || !engine.current) return
    if (engine.current.mode === 'continuous') return
    setMode('ptt')
    engine.current.start('ptt')
  }, [enabled])
  const stopPtt = useCallback(() => {
    if (engine.current?.mode !== 'ptt') return
    engine.current.stop()
    setMode(null)
  }, [])

  // Hold Space to talk, only when focus is on the talk button or on no control at all (never on a field,
  // button, tab or link: those keep Space). Keydown inside the phone iframes never reaches this page.
  useEffect(() => {
    if (!enabled) return
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || !spaceStartsTalk(e.target as Element | null, pttButton.current, document.body)) return
      e.preventDefault()
      startPtt()
    }
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || engine.current?.mode !== 'ptt') return
      e.preventDefault()
      stopPtt()
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', stopPtt)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', stopPtt)
    }
  }, [enabled, startPtt, stopPtt])

  const toggleContinuous = () => {
    if (!engine.current) return
    if (mode === 'continuous') {
      engine.current.stop()
      setMode(null)
    } else {
      setMode('continuous')
      engine.current.start('continuous')
    }
  }

  const lag = medianMs(lags)
  const listening = state === 'listening' && mode !== null

  return (
    <div className="mic">
      <div className="row gap-2">
        <button
          ref={pttButton}
          type="button"
          className={['btn', 'mic__ptt', mode === 'ptt' ? 'is-on' : ''].join(' ')}
          disabled={!enabled || mode === 'continuous'}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            startPtt()
          }}
          onPointerUp={stopPtt}
          onPointerCancel={stopPtt}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.repeat) return
            e.preventDefault()
            startPtt()
          }}
          onKeyUp={(e) => e.key === 'Enter' && stopPtt()}
          aria-pressed={mode === 'ptt'}
        >
          <Icon name="mic" />
          {mode === 'ptt' ? 'Listening — release to send' : 'Hold to talk'}
        </button>
        <button type="button" className="btn" onClick={toggleContinuous} disabled={!enabled} aria-pressed={mode === 'continuous'}>
          <Icon name={mode === 'continuous' ? 'stop' : 'play'} />
          {mode === 'continuous' ? 'Stop listening' : 'Listen continuously'}
        </button>
        <span className="small muted">
          or hold <span className="kbd">Space</span>
        </span>
      </div>
      <div className="row gap-3 small muted">
        <LanguageSelect model={model} />
        <span className="num">{lag !== null ? `Recognition lag ≈ ${(lag / 1000).toFixed(1)} s` : 'Lag measured on first phrase'}</span>
        {listening && <span className="mic__dot">Mic on</span>}
      </div>
      {!enabled && <p className="small muted">The mic works while the room is live.</p>}
      {error && <Banner tone="bad">{error}</Banner>}
      <MicTest lang={room.language} />
      <p className="xsmall muted">Chrome sends mic audio to Google's speech service. AnswerTab and Claude receive only the text.</p>
    </div>
  )
}

function TypeInput({ model }: { model: ConsoleModel }) {
  const toast = useToast()
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const enabled = model.view!.room.status === 'live'
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const t = text.trim()
    if (!t || sending) return
    setSending(true)
    try {
      await model.actions.segment(t, true, 'typed')
      setText('')
    } catch (err) {
      toast(friendlyError(toApiError(err)), 'bad')
    } finally {
      setSending(false)
    }
  }
  return (
    <form className="typein" onSubmit={submit}>
      <label className="sr-only" htmlFor="typein">
        Type what you say on stream
      </label>
      <input
        id="typein"
        className="input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={enabled ? 'Type the answer as you would say it…' : model.view!.room.status === 'draft' ? 'Start the room to type' : 'The stream has ended'}
        disabled={!enabled}
        autoComplete="off"
        maxLength={1000}
      />
      <button type="submit" className="btn btn--primary" disabled={!enabled || !text.trim() || sending}>
        <Icon name={sending ? 'spinner' : 'send'} />
        Send
      </button>
    </form>
  )
}

function ReplayIndicator({ model }: { model: ConsoleModel }) {
  const view = model.view!
  // Only for the stall check (a director that stopped early); the states come from room data.
  const now = useNow(5000)
  const started = view.room.clockStartedAt ? Date.parse(view.room.clockStartedAt) : null
  const p = replayProgress({
    status: view.room.status,
    segments: view.segments,
    tabs: view.tabs,
    questions: view.room.questions,
    interim: !!model.serverInterim,
    clockMs: started === null ? null : now - started,
  })
  return (
    <span
      className={['replay', p.active ? 'is-playing' : ''].join(' ')}
      data-phase={p.phase}
      role="status"
      title="Scripted office-hours audio, transcribed ahead of time. Segments are labeled Replay."
    >
      <span className="replay__bars" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {p.label}
    </span>
  )
}

export function InputBar({ model, onInterim, onLive, compact }: { model: ConsoleModel; onInterim: (t: string | null) => void; onLive: (live: boolean) => void; compact?: boolean }) {
  const view = model.view!
  const supported = speechSupported()
  const [tab, setTab] = useState<'mic' | 'type'>(() => (view.room.kind === 'demo' || !supported ? 'type' : 'mic'))
  return (
    <div className={['inputbar', compact ? 'inputbar--compact' : ''].filter(Boolean).join(' ')}>
      <div className="row">
        <Seg
          label="Transcript input"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'mic', label: 'Mic', icon: 'mic' },
            { value: 'type', label: 'Type', icon: 'keyboard' },
          ]}
        />
        <span className="spacer" />
        {view.room.kind === 'demo' && <ReplayIndicator model={model} />}
      </div>
      {tab === 'type' && <TypeInput model={model} />}
      {tab === 'mic' &&
        (supported ? (
          <MicControl model={model} onInterim={onInterim} onLive={onLive} />
        ) : (
          <Banner tone="warn">Speech recognition needs desktop Chrome. Use Type instead; typed segments are labeled on receipts.</Banner>
        ))}
    </div>
  )
}
