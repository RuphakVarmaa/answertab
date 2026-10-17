// Chrome Web Speech API wrapper: continuous listening with auto-restart, or push-to-talk.
// Chrome streams the audio to Google's speech service; AnswerTab's server only ever gets the text.
import { estimateLagMs } from './lag.js'

/** Speech-recognition languages offered in room settings; the server accepts exactly these (POST /settings). */
export const SPEECH_LANGUAGES: readonly { value: string; label: string }[] = [
  { value: 'en-US', label: 'English (US)' },
  { value: 'en-GB', label: 'English (UK)' },
  { value: 'en-IN', label: 'English (India)' },
  { value: 'en-AU', label: 'English (Australia)' },
  { value: 'en-CA', label: 'English (Canada)' },
]

interface SRAlternative {
  transcript: string
}
interface SRResult {
  readonly isFinal: boolean
  readonly length: number
  readonly [i: number]: SRAlternative
}
interface SREvent {
  readonly resultIndex: number
  readonly results: { readonly length: number; readonly [i: number]: SRResult }
}
interface SRErrorEvent {
  readonly error: string
}
interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  start(): void
  stop(): void
  abort(): void
  onstart: (() => void) | null
  onend: (() => void) | null
  onresult: ((e: SREvent) => void) | null
  onerror: ((e: SRErrorEvent) => void) | null
}
type SRCtor = new () => SpeechRecognitionLike

function ctor(): SRCtor | null {
  const w = window as unknown as { SpeechRecognition?: SRCtor; webkitSpeechRecognition?: SRCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export function speechSupported(): boolean {
  return typeof window !== 'undefined' && ctor() !== null
}

export type SpeechState = 'off' | 'starting' | 'listening' | 'error'
export type SpeechMode = 'continuous' | 'ptt'

export interface SpeechCallbacks {
  onInterim: (text: string) => void
  onFinal: (text: string, lagMs: number) => void
  onState: (state: SpeechState, message?: string) => void
}

const ERRORS: Record<string, string> = {
  'not-allowed': 'Microphone access is blocked. Allow the mic for this site in Chrome, then try again.',
  'service-not-allowed': 'Chrome would not start its speech service here. Use Type instead.',
  'audio-capture': 'No microphone was found.',
  network: "Chrome can't reach its speech service. Check the connection or use Type.",
  'language-not-supported': 'Chrome does not support speech for this room language.',
}

export class SpeechInput {
  private rec: SpeechRecognitionLike | null = null
  private want: SpeechMode | null = null
  private lastInterim = ''
  private lastInterimAt: number | null = null
  private speechStartAt: number | null = null
  private quickEnds = 0
  private startedAt = 0
  private restartTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private lang: string,
    private cb: SpeechCallbacks,
  ) {}

  setLang(lang: string) {
    this.lang = lang
  }

  get mode(): SpeechMode | null {
    return this.want
  }

  start(mode: SpeechMode) {
    this.want = mode
    if (!this.rec) this.open()
  }

  /** Push-to-talk release or Stop: Chrome flushes a final result, then ends. */
  stop() {
    this.want = null
    clearTimeout(this.restartTimer)
    this.rec?.stop()
  }

  dispose() {
    this.want = null
    clearTimeout(this.restartTimer)
    if (this.rec) {
      this.rec.onend = null
      this.rec.abort()
      this.rec = null
    }
  }

  private open() {
    const C = ctor()
    if (!C) {
      this.cb.onState('error', 'Speech recognition needs desktop Chrome. Use Type instead.')
      return
    }
    const rec = new C()
    rec.lang = this.lang
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 1
    rec.onstart = () => this.cb.onState('listening')
    rec.onresult = (e) => this.onResult(e)
    rec.onerror = (e) => this.onError(e.error)
    rec.onend = () => this.onEnd()
    this.rec = rec
    this.startedAt = Date.now()
    this.cb.onState('starting')
    try {
      rec.start()
    } catch {
      // start() throws if a session is already running; onend will sort it out.
    }
  }

  private onResult(e: SREvent) {
    const now = Date.now()
    let interim = ''
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i]!
      const text = r[0]?.transcript ?? ''
      if (r.isFinal) {
        const clean = text.trim()
        if (clean) this.cb.onFinal(clean, estimateLagMs({ finalAt: now, lastInterimAt: this.lastInterimAt, speechStartAt: this.speechStartAt }))
        this.lastInterim = ''
        this.lastInterimAt = null
        this.speechStartAt = null
      } else {
        interim += text
      }
    }
    interim = interim.trim()
    if (interim && interim !== this.lastInterim) {
      this.speechStartAt ??= now
      this.lastInterimAt = now
      this.lastInterim = interim
    }
    this.cb.onInterim(interim)
  }

  private onError(code: string) {
    if (code === 'no-speech' || code === 'aborted') return
    const msg = ERRORS[code] ?? `Speech error: ${code}`
    if (code === 'not-allowed' || code === 'service-not-allowed' || code === 'audio-capture' || code === 'language-not-supported') this.want = null
    this.cb.onState('error', msg)
  }

  private onEnd() {
    this.rec = null
    // Chrome sometimes ends with words still interim (push-to-talk released mid-word). Keep them.
    if (this.lastInterim) {
      const now = Date.now()
      this.cb.onFinal(this.lastInterim, estimateLagMs({ finalAt: now, lastInterimAt: this.lastInterimAt, speechStartAt: this.speechStartAt }))
      this.lastInterim = ''
      this.lastInterimAt = null
      this.speechStartAt = null
      this.cb.onInterim('')
    }
    if (this.want === 'continuous') {
      // Auto-restart. Back off if sessions keep dying immediately (permission or device trouble).
      this.quickEnds = Date.now() - this.startedAt < 1500 ? this.quickEnds + 1 : 0
      const delay = this.quickEnds > 2 ? Math.min(8000, 500 * 2 ** this.quickEnds) : 150
      this.restartTimer = setTimeout(() => this.want === 'continuous' && !this.rec && this.open(), delay)
      return
    }
    if (this.want === 'ptt') {
      this.open()
      return
    }
    this.cb.onState('off')
  }
}

export interface MicTestResult {
  ok: boolean
  peak: number
  heard: string
  error?: string
}

/** Five-second mic check: input level from getUserMedia plus whatever Chrome's recognizer hears. */
export async function runMicTest(lang: string, ms: number, onLevel: (level: number) => void, onHeard: (text: string) => void): Promise<MicTestResult> {
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch (e) {
    const name = e instanceof DOMException ? e.name : ''
    return { ok: false, peak: 0, heard: '', error: name === 'NotAllowedError' ? ERRORS['not-allowed'] : ERRORS['audio-capture'] }
  }
  const ctx = new AudioContext()
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 512
  ctx.createMediaStreamSource(stream).connect(analyser)
  const buf = new Uint8Array(analyser.fftSize)
  let peak = 0
  let heard = ''
  let raf = 0
  const tick = () => {
    analyser.getByteTimeDomainData(buf)
    let sum = 0
    for (const v of buf) sum += ((v - 128) / 128) ** 2
    const level = Math.min(1, Math.sqrt(sum / buf.length) * 4)
    peak = Math.max(peak, level)
    onLevel(level)
    raf = requestAnimationFrame(tick)
  }
  tick()

  const C = ctor()
  const rec = C ? new C() : null
  if (rec) {
    rec.lang = lang
    rec.continuous = true
    rec.interimResults = true
    rec.onresult = (e) => {
      let t = ''
      for (let i = 0; i < e.results.length; i++) t += e.results[i]![0]?.transcript ?? ''
      heard = t.trim()
      onHeard(heard)
    }
    rec.onerror = () => {}
    try {
      rec.start()
    } catch {
      /* already running */
    }
  }
  await new Promise((r) => setTimeout(r, ms))
  cancelAnimationFrame(raf)
  rec?.abort()
  stream.getTracks().forEach((t) => t.stop())
  await ctx.close().catch(() => {})
  onLevel(0)
  return { ok: peak > 0.05 || heard.length > 0, peak, heard }
}
