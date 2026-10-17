// Question card state -> what the UI shows. Every state has an icon and text; color is only a third cue.
import type { BackingView, FanSelfView, PricesView, QuestionState, QuestionView } from '../../shared/types.js'
import { canReserve } from '../../shared/money.js'
import { money } from './format.js'

export type Tone = 'neutral' | 'info' | 'ok' | 'warn' | 'bad' | 'muted'
export type StateIcon = 'circle' | 'pause' | 'spinner' | 'lock' | 'flag' | 'check' | 'slash' | 'eyeOff'

export interface CardStatus {
  state: QuestionState
  label: string
  detail: string | null
  icon: StateIcon
  tone: Tone
  /** The card should show its quote. */
  showsQuote: boolean
  /** Money is held against this card right now (locked or approved). */
  locked: boolean
}

type CardInput = Pick<QuestionView, 'state' | 'backedCents' | 'rating' | 'creatorConfirmed'>

/**
 * `myCents` (fan view): the fan's own backing on this card, so a phone reads "$6 locked"
 * while the console reads the card total.
 */
export function cardStatus(q: CardInput, opts: { myCents?: number | null; late?: boolean } = {}): CardStatus {
  const amount = money(opts.myCents ?? q.backedCents, { compact: true })
  const base = { state: q.state, detail: null, showsQuote: false, locked: false }
  // Fan view: this fan backed after the answer started, so their share is never charged.
  if (opts.late && (q.state === 'verifying' || q.state === 'locked' || q.state === 'approved'))
    return { ...base, label: LATE_LABEL, detail: 'Your hold for this card is released', icon: 'slash', tone: 'muted', showsQuote: true }
  switch (q.state) {
    case 'open':
      return { ...base, label: 'Open', icon: 'circle', tone: 'neutral' }
    case 'deflected':
      return { ...base, label: 'Deflected — not charged', detail: 'The card stays open', icon: 'pause', tone: 'info' }
    case 'verifying':
      return { ...base, label: 'Answer detected — verifying', detail: 'Claude Opus re-checks the quote', icon: 'spinner', tone: 'warn', showsQuote: true }
    case 'locked':
      return {
        ...base,
        label: `Answered — ${amount} locked`,
        icon: 'lock',
        tone: 'ok',
        showsQuote: true,
        locked: true,
      }
    case 'review':
      return { ...base, label: 'Needs review', detail: 'Partial or unsure — the creator decides', icon: 'flag', tone: 'warn', showsQuote: true }
    case 'approved':
      return {
        ...base,
        label: q.rating === 'half' ? 'Approved — half' : q.rating === 'none' ? 'Approved — not charged' : 'Approved',
        icon: q.rating === 'none' ? 'slash' : 'check',
        tone: q.rating === 'none' ? 'muted' : 'ok',
        showsQuote: true,
        locked: q.rating !== 'none',
      }
    case 'unpaid':
      return { ...base, label: 'Not charged', detail: 'Hold released for this card', icon: 'slash', tone: 'muted' }
    case 'hidden':
      return { ...base, label: 'Hidden — holds released', icon: 'eyeOff', tone: 'muted' }
  }
}

/** Ranked by backing (cents, then backers), oldest first on ties. Hidden cards are dropped unless asked for. */
export function rankQuestions<T extends Pick<QuestionView, 'state' | 'backedCents' | 'backers' | 'number'>>(
  questions: readonly T[],
  opts: { includeHidden?: boolean } = {},
): T[] {
  return questions
    .filter((q) => opts.includeHidden || q.state !== 'hidden')
    .slice()
    .sort((a, b) => b.backedCents - a.backedCents || b.backers - a.backers || a.number - b.number)
}

/** Cards that still take new backers. Answered cards close to new backers. */
export function isBackable(state: QuestionState): boolean {
  return state === 'open' || state === 'deflected'
}

export function myBacking(questionId: string, backings: readonly BackingView[]): BackingView | null {
  return backings.find((b) => b.questionId === questionId && b.state !== 'released') ?? backings.find((b) => b.questionId === questionId) ?? null
}

/** BackingView as the server may extend it: the room-clock time of the backing, or its own chargeable flag. */
export type BackingIn = BackingView & { backedAtMs?: number | null; chargeable?: boolean | null; late?: boolean | null }

/**
 * A backing made after the answer started is never charged (chargeForBacking), so the phone must not say
 * "$3 locked" for it. Uses the server's flag when sent, else compares the backing time with the answer start.
 */
export function isLateBacking(b: BackingIn, q: Pick<QuestionView, 'quoteAtMs'>): boolean {
  if (typeof b.chargeable === 'boolean') return !b.chargeable
  if (typeof b.late === 'boolean') return b.late
  return typeof b.backedAtMs === 'number' && typeof q.quoteAtMs === 'number' && b.backedAtMs > q.quoteAtMs
}

export const LATE_LABEL = 'Joined after the answer — not charged'

export type BackBlock = 'state' | 'mine' | 'no_tab' | 'full' | null

/** Why a fan cannot "+ me too" a card, or null when they can. */
export function backBlock(q: Pick<QuestionView, 'id' | 'state'>, me: FanSelfView | null, prices: PricesView): BackBlock {
  if (!isBackable(q.state)) return 'state'
  if (me && me.backings.some((b) => b.questionId === q.id)) return 'mine'
  const tab = me?.tab
  if (!tab || tab.state !== 'held') return 'no_tab'
  if (!canReserve(tab.ceilingCents, tab.reservedCents, prices.metooCents)) return 'full'
  return null
}

export function canAsk(me: FanSelfView | null, prices: PricesView): boolean {
  const tab = me?.tab
  return !!tab && tab.state === 'held' && canReserve(tab.ceilingCents, tab.reservedCents, prices.questionCents)
}
