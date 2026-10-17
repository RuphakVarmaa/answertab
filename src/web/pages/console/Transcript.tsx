// Transcript with word-level selection. Drag across words (or click one, shift-click another), or focus the
// transcript and use the arrow keys (Shift extends), to point at the span that answers a question; the server
// runs the same guard on it as on Claude's spans.
import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import type { EvidenceSpan, QuestionView, Segment } from '../../../shared/types.js'
import { Icon } from '../../components/Icon.js'
import { Empty } from '../../components/ui.js'
import { toApiError } from '../../lib/api.js'
import { SOURCE_LABEL, formatClock, plural } from '../../lib/format.js'
import { friendlyError } from '../../lib/messages.js'
import { findQuoteSpan, moveWord, spanContains, spanFromRefs, spanWords, type WordMove, type WordRef } from '../../lib/spans.js'
import type { ConsoleModel, VerdictNote } from './useConsole.js'

const MIN_SPAN_WORDS = 4
const EVIDENCE_STATES = new Set(['verifying', 'locked', 'review', 'approved'])
const SOURCE_ICON = { spoken: 'mic', typed: 'keyboard', replay: 'replay' } as const
const NOOP = () => {}
const KEY_MOVES: Record<string, WordMove> = { ArrowLeft: 'prev', ArrowRight: 'next', ArrowUp: 'prevSeg', ArrowDown: 'nextSeg', Home: 'first', End: 'last' }

interface Evidence {
  span: EvidenceSpan
  number: number
  tone: 'ok' | 'warn'
}

const SegmentRow = memo(function SegmentRow({
  seg,
  selection,
  caretWord,
  evidence,
  onDown,
  onEnter,
}: {
  seg: Segment
  selection: EvidenceSpan | null
  /** Keyboard caret's word index when it is in this segment. */
  caretWord: number | null
  evidence: Evidence[]
  onDown: (ref: WordRef, extend: boolean) => void
  onEnter: (ref: WordRef) => void
}) {
  const ev = evidence.filter((e) => e.span.startSeg <= seg.seq && e.span.endSeg >= seg.seq)
  return (
    <li className="tseg" data-source={seg.source}>
      <span className="tseg__time num">{formatClock(seg.tStartMs)}</span>
      <span className="tseg__src" title={SOURCE_LABEL[seg.source]}>
        <Icon name={SOURCE_ICON[seg.source]} label={SOURCE_LABEL[seg.source]} />
      </span>
      <p className="tseg__text">
        {seg.words.map((w, i) => {
          const ref = { seg: seg.seq, word: i }
          const hit = ev.find((e) => spanContains(e.span, ref))
          const sel = selection && spanContains(selection, ref)
          const startsEv = hit && hit.span.startSeg === seg.seq && hit.span.startWord === i
          return (
            <span
              key={i}
              className={['w', hit ? `w--ev w--${hit.tone}` : '', sel ? 'w--sel' : '', caretWord === i ? 'w--caret' : ''].filter(Boolean).join(' ')}
              data-w={`${seg.seq}:${i}`}
              onPointerDown={(e) => {
                if (e.button !== 0) return
                e.preventDefault()
                // Touch has no shift key: a second tap extends a one-word selection.
                onDown(ref, e.shiftKey || e.pointerType !== 'mouse')
              }}
              onPointerEnter={(e) => e.buttons === 1 && onEnter(ref)}
            >
              {startsEv && <sup className="w__tag">#{hit.number}</sup>}
              {w}{' '}
            </span>
          )
        })}
      </p>
    </li>
  )
})

function NoteLine({ n }: { n: VerdictNote }) {
  const text: Record<VerdictNote['action'], string> = {
    lock: 'answer locked',
    verifying: 'answer detected, verifying',
    review: 'sent to review',
    deflected: 'deflected, card stays open',
    ignore: 'ignored',
  }
  const icon = { lock: 'lock', verifying: 'spinner', review: 'flag', deflected: 'pause', ignore: 'circle' }[n.action]
  return (
    <li className="tnote" data-action={n.action}>
      <Icon name={icon} />
      <span>
        <strong>#{n.questionNumber}</strong> {text[n.action]}
        {n.reason && <span className="muted"> — {n.reason}</span>}
      </span>
    </li>
  )
}

export function Transcript({
  model,
  localInterim,
  pointing,
  onPointDone,
  large,
  footer,
}: {
  model: ConsoleModel
  localInterim: string | null
  pointing: QuestionView | null
  onPointDone: () => void
  large?: boolean
  footer?: ReactNode
}) {
  const view = model.view!
  const segments = useMemo(() => view.segments.filter((s) => s.final).sort((a, b) => a.seq - b.seq), [view.segments])
  const [anchor, setAnchor] = useState<WordRef | null>(null)
  const [focus, setFocus] = useState<WordRef | null>(null)
  const [target, setTarget] = useState<string>('')
  const [pointError, setPointError] = useState<string | null>(null)
  const [stick, setStick] = useState(true)
  const scroller = useRef<HTMLDivElement>(null)

  const selection = anchor && focus ? spanFromRefs(anchor, focus) : null
  const selWords = selection ? spanWords(segments, selection) : []

  const evidence = useMemo<Evidence[]>(
    () =>
      view.room.questions
        .filter((q) => EVIDENCE_STATES.has(q.state) && q.quote)
        .flatMap((q) => {
          const span = findQuoteSpan(segments, q.quote)
          return span ? [{ span, number: q.number, tone: q.state === 'review' || q.state === 'verifying' ? ('warn' as const) : ('ok' as const) }] : []
        }),
    [view.room.questions, segments],
  )

  const pointable = view.room.questions.filter((q) => q.state === 'open' || q.state === 'deflected' || q.state === 'review')
  const chosen = pointing ?? pointable.find((q) => q.id === target) ?? null

  useEffect(() => {
    if (!pointing) return
    setPointError(null)
    // Keyboard users who pressed "Point at answer" land in the transcript, ready for the arrow keys.
    scroller.current?.focus({ preventScroll: true })
  }, [pointing])

  useEffect(() => {
    const el = scroller.current
    if (el && stick) el.scrollTop = el.scrollHeight
  }, [segments.length, localInterim, model.serverInterim, stick])

  const clear = () => {
    setAnchor(null)
    setFocus(null)
    setPointError(null)
  }

  useEffect(() => {
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        clear()
        onPointDone()
      }
    }
    window.addEventListener('keydown', up)
    return () => window.removeEventListener('keydown', up)
  }, [onPointDone])

  const sel = useRef({ anchor, focus })
  sel.current = { anchor, focus }
  const onDown = useCallback((ref: WordRef, extend: boolean) => {
    setPointError(null)
    if (extend && sel.current.anchor) setFocus(ref)
    else {
      setAnchor(ref)
      setFocus(ref)
    }
  }, [])
  const onEnter = useCallback((ref: WordRef) => {
    if (sel.current.anchor) setFocus(ref)
  }, [])

  const attach = async () => {
    if (!selection || !chosen) return
    if (selWords.length < MIN_SPAN_WORDS) {
      setPointError(`Pick at least ${MIN_SPAN_WORDS} words; the guard rejects shorter spans.`)
      return
    }
    try {
      await model.actions.point(chosen.id, selection)
      clear()
      onPointDone()
    } catch (e) {
      setPointError(friendlyError(toApiError(e)))
    }
  }

  const interim = localInterim || model.serverInterim
  const canPoint = view.room.status === 'live' || view.room.status === 'ended'

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!canPoint || e.target !== e.currentTarget) return
    if (e.key === 'Enter' && selection && chosen) {
      e.preventDefault()
      void attach()
      return
    }
    const move = KEY_MOVES[e.key]
    if (!move) return
    // Read and write the ref so key repeats faster than a render still move one word each.
    const cur = sel.current
    const next = moveWord(segments, cur.focus, move)
    if (!next) return
    e.preventDefault()
    setPointError(null)
    const anchorNext = e.shiftKey && cur.anchor ? cur.anchor : next
    sel.current = { anchor: anchorNext, focus: next }
    setAnchor(anchorNext)
    setFocus(next)
    scroller.current?.querySelector(`[data-w="${next.seg}:${next.word}"]`)?.scrollIntoView({ block: 'nearest' })
  }

  return (
    <div className={['transcript', large ? 'transcript--lg' : ''].filter(Boolean).join(' ')}>
      {pointing && (
        <div className="transcript__pointing" role="status">
          <Icon name="highlight" />
          <span>
            Select the words that answer <strong>#{pointing.number}</strong>. Drag across the transcript, or click the first word and shift-click
            the last. Keyboard: arrow keys move, <span className="kbd">Shift</span>+arrows extend, <span className="kbd">Enter</span> attaches,{' '}
            <span className="kbd">Esc</span> cancels.
          </span>
        </div>
      )}
      <div
        className="transcript__scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
        }}
        aria-live="off"
        tabIndex={canPoint && segments.length > 0 ? 0 : undefined}
        role={canPoint && segments.length > 0 ? 'group' : undefined}
        aria-label={canPoint && segments.length > 0 ? 'Transcript. Arrow keys pick words, Shift plus arrows extends the selection, Enter attaches it.' : undefined}
        onKeyDown={onKey}
      >
        {segments.length === 0 && !interim ? (
          <Empty icon="mic">
            {view.room.status === 'draft' ? 'Start the room, then talk or type. The transcript appears here.' : 'Waiting for the creator to speak or type.'}
          </Empty>
        ) : (
          <ol className="tlist">
            {segments.map((s) => (
              <SegmentRow
                key={s.seq}
                seg={s}
                selection={canPoint ? selection : null}
                caretWord={canPoint && focus && focus.seg === s.seq ? focus.word : null}
                evidence={evidence}
                onDown={canPoint ? onDown : NOOP}
                onEnter={canPoint ? onEnter : NOOP}
              />
            ))}
            {interim && (
              <li className="tseg tseg--interim">
                <span className="tseg__time label">now</span>
                <span className="tseg__src">
                  <Icon name="mic" />
                </span>
                <p className="tseg__text">
                  <span className="shimmer">{interim}</span> <span className="tag">possible answer · not final</span>
                </p>
              </li>
            )}
          </ol>
        )}
      </div>
      {!stick && (
        <button type="button" className="btn btn--sm transcript__jump" onClick={() => setStick(true)}>
          <Icon name="scroll" /> Latest
        </button>
      )}

      {selection && canPoint && (
        <div className="selbar" role="region" aria-label="Selected words">
          <p className="selbar__quote">
            <mark>{selWords.join(' ')}</mark>
          </p>
          <div className="row">
            <span className="small muted num" aria-live="polite">
              {plural(selWords.length, 'word')} selected
            </span>
            <span className="spacer" />
            {!pointing && (
              <label className="row small">
                <span>Attach to</span>
                <select className="input input--sm" value={target} onChange={(e) => setTarget(e.target.value)}>
                  <option value="">Choose a question</option>
                  {pointable.map((q) => (
                    <option key={q.id} value={q.id}>
                      #{q.number} {q.text.slice(0, 48)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button type="button" className="btn btn--sm btn--ghost" onClick={clear}>
              Clear
            </button>
            <button type="button" className="btn btn--sm btn--primary" disabled={!chosen || model.busy === `point:${chosen.id}`} onClick={attach}>
              <Icon name={model.busy?.startsWith('point:') ? 'spinner' : 'highlight'} />
              {chosen ? `Attach as evidence for #${chosen.number}` : 'Attach as evidence'}
            </button>
          </div>
          {pointError && <p className="selbar__error small">{pointError}</p>}
        </div>
      )}

      {model.notes.length > 0 && (
        <ul className="tnotes" aria-label="Detector notes" aria-live="polite">
          {model.notes.slice(0, 3).map((n) => (
            <NoteLine key={n.id} n={n} />
          ))}
        </ul>
      )}
      {footer}
    </div>
  )
}
