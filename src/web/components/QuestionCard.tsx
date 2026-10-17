import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { QuestionView, SegmentSource } from '../../shared/types.js'
import { cardStatus } from '../lib/cardState.js'
import { SOURCE_LABEL, formatClock, isQuoteTruncated, money, plural, quoteEllipsis } from '../lib/format.js'
import { Icon } from './Icon.js'
import { StateChip } from './StateChip.js'

const SOURCE_ICON: Record<SegmentSource, string> = { spoken: 'mic', typed: 'keyboard', replay: 'replay' }

export function Quote({
  text,
  atMs,
  source,
  creatorConfirmed,
  truncated = false,
  tone,
}: {
  text: string
  atMs: number | null
  source: SegmentSource | null
  creatorConfirmed?: boolean
  /** The span stops mid-sentence: show an ellipsis after the highlighted words (they stay exactly as cut). */
  truncated?: boolean
  tone?: string
}) {
  const ellipsis = quoteEllipsis(text, truncated)
  return (
    <figure className="quote" data-tone={tone}>
      <blockquote className="quote__text" style={{ margin: 0 }}>
        <mark>{text}</mark>
        {ellipsis && (
          <>
            <span className="quote__more" aria-hidden="true">
              {ellipsis}
            </span>
            <span className="sr-only"> (the answer continues past this quote)</span>
          </>
        )}
      </blockquote>
      <figcaption className="quote__meta">
        {atMs !== null && (
          <span className="num" title="Room clock">
            <Icon name="clock" className="inline-icon" /> {formatClock(atMs)}
          </span>
        )}
        {source && (
          <span className="tag">
            <Icon name={SOURCE_ICON[source]} />
            {SOURCE_LABEL[source]}
          </span>
        )}
        {creatorConfirmed && (
          <span className="tag">
            <Icon name="hand" />
            Creator-confirmed
          </span>
        )}
      </figcaption>
    </figure>
  )
}

/** Plays a one-shot class when `state` changes into one of `into` (not on first render). */
export function useTransitionClass(state: string, into: readonly string[] | 'any', cls: string, ms = 900): string {
  const prev = useRef(state)
  const [active, setActive] = useState(false)
  useEffect(() => {
    if (prev.current === state) return
    prev.current = state
    if (into !== 'any' && !into.includes(state)) return
    setActive(true)
    const t = setTimeout(() => setActive(false), ms)
    return () => clearTimeout(t)
  }, [state, into, ms])
  return active ? cls : ''
}

const LOCKISH = ['locked', 'approved'] as const

export function QuestionCard({
  q,
  myCents,
  mine,
  actions,
  footer,
  motion = 'lock',
  large,
  showAsker = true,
  late,
}: {
  q: QuestionView
  /** Fan view: the fan's own backing on this card. */
  myCents?: number | null
  /** Fan view: the fan backed after the answer started (never charged). */
  late?: boolean
  mine?: 'asked' | 'backed' | null
  actions?: ReactNode
  footer?: ReactNode
  motion?: 'lock' | 'flip'
  large?: boolean
  showAsker?: boolean
}) {
  const st = cardStatus(q, { myCents, late })
  const anim = useTransitionClass(q.state, motion === 'flip' ? 'any' : LOCKISH, motion === 'flip' ? 'is-flip' : 'is-locking', motion === 'flip' ? 600 : 950)
  const popped = anim !== '' && st.locked
  return (
    <article className={['qcard', anim, large ? 'qcard--lg' : ''].filter(Boolean).join(' ')} data-tone={st.tone} aria-label={`Question ${q.number}: ${st.label}`}>
      <div className="qcard__top">
        <span className="qcard__num">#{q.number}</span>
        {showAsker && <span>{q.askerName}</span>}
        <span className="num">{formatClock(q.askedAtMs)}</span>
        {mine && <span className="tag">{mine === 'asked' ? 'You asked' : 'You backed'}</span>}
        {q.similarTo !== null && <span className="tag">Similar to #{q.similarTo}</span>}
        <span className="qcard__amount num" title={`${plural(q.backers, 'fan')} backing`}>
          {money(q.backedCents, { compact: true })}
        </span>
      </div>
      <p className="qcard__text">{q.text}</p>
      <div className="qcard__row">
        <StateChip icon={st.icon} label={st.label} tone={st.tone} pop={popped} large={large} />
        <span className="muted small num">
          <Icon name="users" className="inline-icon" /> {plural(q.backers, 'fan')}
        </span>
        {st.detail && <span className="muted xsmall">{st.detail}</span>}
      </div>
      {st.showsQuote && q.quote && <Quote text={q.quote} atMs={q.quoteAtMs} source={q.quoteSource} creatorConfirmed={q.creatorConfirmed} truncated={isQuoteTruncated(q)} tone={st.tone} />}
      {footer}
      {actions && <div className="qcard__actions">{actions}</div>}
    </article>
  )
}
