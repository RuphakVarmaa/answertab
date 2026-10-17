import { describe, expect, it } from 'vitest'
import type { FanSelfView, PricesView, QuestionState, QuestionView, TabView } from '../src/shared/types.js'
import { backBlock, canAsk, cardStatus, isBackable, myBacking, rankQuestions } from '../src/web/lib/cardState.js'
import { isQuoteTruncated, quoteEllipsis } from '../src/web/lib/format.js'
import { lineStatus } from '../src/web/lib/receipt.js'
import { liveReview } from '../src/web/lib/review.js'

const PRICES: PricesView = { questionCents: 600, metooCents: 300, ceilingsCents: [1000, 2000, 4000], platformFeeBps: 500 }
const STATES: QuestionState[] = ['open', 'hidden', 'deflected', 'verifying', 'locked', 'review', 'approved', 'unpaid']

function q(over: Partial<QuestionView> = {}): QuestionView {
  return {
    id: 'q1',
    number: 1,
    text: 'How should I split a big API project into folders?',
    askerName: 'Maya',
    state: 'open',
    backers: 1,
    backedCents: 600,
    similarTo: null,
    askedAtMs: 1000,
    quote: null,
    quoteAtMs: null,
    quoteSource: null,
    creatorConfirmed: false,
    confidence: null,
    rating: null,
    ...over,
  }
}

function tab(over: Partial<TabView> = {}): TabView {
  return {
    id: 't1',
    fanId: 'f1',
    ceilingCents: 1000,
    reservedCents: 0,
    funding: 'card',
    state: 'held',
    authStatus: 'CREATED',
    orderId: 'O1',
    authorizationId: 'A1',
    captureId: null,
    capturedCents: 0,
    releasedCents: 0,
    feeCents: null,
    refundedCents: 0,
    receiptToken: null,
    declineReason: null,
    ...over,
  }
}

function me(over: Partial<FanSelfView> = {}): FanSelfView {
  return { fanId: 'f1', displayName: 'Theo', tab: tab(), backings: [], ...over }
}

describe('cardStatus', () => {
  it('gives every state an icon and words, never color alone', () => {
    for (const state of STATES) {
      const s = cardStatus(q({ state }))
      expect(s.label.length).toBeGreaterThan(2)
      expect(s.icon).toBeTruthy()
      expect(s.tone).toBeTruthy()
    }
  })

  it('uses the exact brief copy for the key states', () => {
    expect(cardStatus(q({ state: 'deflected' })).label).toBe('Deflected — not charged')
    expect(cardStatus(q({ state: 'verifying' })).label).toBe('Answer detected — verifying')
    expect(cardStatus(q({ state: 'review' })).label).toBe('Needs review')
    expect(cardStatus(q({ state: 'unpaid' })).label).toBe('Not charged')
    expect(cardStatus(q({ state: 'open' })).label).toBe('Open')
  })

  it('shows the card total on the console and the fan\'s own share on a phone', () => {
    const card = q({ state: 'locked', backedCents: 1200, quote: 'one router file per feature' })
    expect(cardStatus(card).label).toBe('Answered — $12 locked')
    expect(cardStatus(card, { myCents: 300 }).label).toBe('Answered — $3 locked')
    expect(cardStatus(card, { myCents: 650 }).label).toBe('Answered — $6.50 locked')
    expect(cardStatus(card).locked).toBe(true)
    expect(cardStatus(card).showsQuote).toBe(true)
  })

  it('marks half and none approvals', () => {
    expect(cardStatus(q({ state: 'approved', rating: 'half' })).label).toBe('Approved — half')
    const none = cardStatus(q({ state: 'approved', rating: 'none' }))
    expect(none.locked).toBe(false)
    expect(none.icon).toBe('slash')
  })

  it('never shows a quote on open or deflected cards', () => {
    expect(cardStatus(q({ state: 'open', quote: 'x' })).showsQuote).toBe(false)
    expect(cardStatus(q({ state: 'deflected', quote: 'x' })).showsQuote).toBe(false)
  })
})

describe('rankQuestions', () => {
  it('ranks by backed cents, then backers, then number, and drops hidden cards', () => {
    const list = [
      q({ id: 'a', number: 1, backedCents: 600, backers: 1 }),
      q({ id: 'b', number: 2, backedCents: 1200, backers: 3 }),
      q({ id: 'c', number: 3, backedCents: 600, backers: 2 }),
      q({ id: 'd', number: 4, backedCents: 9000, backers: 9, state: 'hidden' }),
      q({ id: 'e', number: 5, backedCents: 600, backers: 1 }),
    ]
    expect(rankQuestions(list).map((x) => x.id)).toEqual(['b', 'c', 'a', 'e'])
    expect(rankQuestions(list, { includeHidden: true })[0]!.id).toBe('d')
    expect(list[0]!.id).toBe('a') // input untouched
  })
})

describe('backing rules', () => {
  it('only open and deflected cards take new backers', () => {
    expect(STATES.filter(isBackable)).toEqual(['open', 'deflected'])
  })

  it('explains why a fan cannot back a card', () => {
    const card = q({ id: 'q9' })
    expect(backBlock(card, me(), PRICES)).toBeNull()
    expect(backBlock(q({ state: 'locked' }), me(), PRICES)).toBe('state')
    expect(backBlock(card, me({ backings: [{ id: 'b', questionId: 'q9', questionNumber: 1, kind: 'ask', amountCents: 600, chargeCents: null, state: 'reserved' }] }), PRICES)).toBe('mine')
    expect(backBlock(card, me({ tab: null }), PRICES)).toBe('no_tab')
    expect(backBlock(card, me({ tab: tab({ state: 'declined' }) }), PRICES)).toBe('no_tab')
    expect(backBlock(card, me({ tab: tab({ reservedCents: 800 }) }), PRICES)).toBe('full')
    expect(backBlock(card, me({ tab: tab({ reservedCents: 700 }) }), PRICES)).toBeNull()
  })

  it('a full tab disables asking but may still allow a me-too', () => {
    expect(canAsk(me({ tab: tab({ reservedCents: 400 }) }), PRICES)).toBe(true)
    expect(canAsk(me({ tab: tab({ reservedCents: 600 }) }), PRICES)).toBe(false)
    expect(backBlock(q({ id: 'z' }), me({ tab: tab({ reservedCents: 600 }) }), PRICES)).toBeNull()
    expect(canAsk(null, PRICES)).toBe(false)
  })

  it('finds the fan\'s active backing first', () => {
    const backings = [
      { id: 'old', questionId: 'q1', questionNumber: 1, kind: 'metoo' as const, amountCents: 300, chargeCents: 0, state: 'released' as const },
      { id: 'new', questionId: 'q1', questionNumber: 1, kind: 'metoo' as const, amountCents: 300, chargeCents: null, state: 'reserved' as const },
    ]
    expect(myBacking('q1', backings)?.id).toBe('new')
    expect(myBacking('q2', backings)).toBeNull()
  })
})

describe('partial quotes end with an ellipsis (P18)', () => {
  it('reads only an explicit quoteTruncated: true', () => {
    expect(isQuoteTruncated({ quoteTruncated: true })).toBe(true)
    expect(isQuoteTruncated({ quoteTruncated: false })).toBe(false)
    expect(isQuoteTruncated({ quoteTruncated: 'yes' })).toBe(false)
    expect(isQuoteTruncated(q())).toBe(false)
    expect(isQuoteTruncated(null)).toBe(false)
  })
  it('appends one ellipsis after the cut words, never two', () => {
    expect(quoteEllipsis('Tests: mostly next to the code, but', true)).toBe('\u2026')
    expect(quoteEllipsis('Tests: mostly next to the code, but', false)).toBe('')
    expect(quoteEllipsis('and so on\u2026', true)).toBe('')
    expect(quoteEllipsis('and so on...', true)).toBe('')
    // A span that ends on a finished sentence reads complete, even if the segment goes on.
    expect(quoteEllipsis('Use one router per feature.', true)).toBe('')
    expect(quoteEllipsis('Is that clear?', true)).toBe('')
  })
  it("labels a half-charged receipt line 'Partial answer, half'", () => {
    const line = { backingId: 'b', questionNumber: 2, questionText: 'Q2', kind: 'metoo' as const, amountCents: 300, chargeCents: 150, status: 'charged' as const, rating: 'half' as const, quote: 'mostly next to the code, but', quoteAtMs: 1, quoteSource: 'replay' as const, creatorConfirmed: false, contest: null, quoteTruncated: true }
    expect(lineStatus(line).label).toBe('Partial answer, half')
    expect(isQuoteTruncated(line)).toBe(true)
  })
  it('keeps the flag on the review list as live updates arrive', () => {
    const item = { questionNumber: 2, questionId: 'q2', text: 'Q2', state: 'review' as const, quote: 'mostly next to the code, but', confidence: 0.7, verdict: null, backers: 1, lockedCents: 300, quoteTruncated: true }
    const live = q({ id: 'q2', number: 2, state: 'review', quote: 'mostly next to the code, but', quoteTruncated: true } as Partial<QuestionView>)
    expect(liveReview([item], [live])![0]).toMatchObject({ quoteTruncated: true })
    expect(liveReview([{ ...item, quoteTruncated: false }], [{ ...live, quoteTruncated: true } as QuestionView])![0]!.quoteTruncated).toBe(true)
    expect(liveReview([item], [q({ id: 'q2', number: 2, state: 'review', quote: 'mostly next to the code, but' })])![0]!.quoteTruncated).toBe(true)
    const appended = liveReview([], [{ ...live, id: 'q3', number: 3 } as QuestionView])!
    expect(appended[0]).toMatchObject({ questionId: 'q3', quoteTruncated: true })
  })
})
