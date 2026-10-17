// End-stream review: default ratings and the settle payload. Unrated partials are never charged.
import type { QuestionView, Rating, ReviewItem } from '../../shared/types.js'

export type DraftRatings = Record<number, Rating | null>

/** The server adds chargedByDefault: false to a lock that happened after End, which is charged only when rated. */
export type ReviewItemIn = ReviewItem & { chargedByDefault?: boolean; quoteTruncated?: boolean }

/** A lock the creator must rate before it can be charged (it locked after End). */
export function needsRating(item: ReviewItemIn): boolean {
  return item.state === 'review' || (item.state === 'locked' && item.chargedByDefault === false)
}

/** Locks (and already approved cards) default to Full; partials and after-End locks start unrated. Everything else is not chargeable. */
export function defaultRatings(items: readonly ReviewItemIn[]): DraftRatings {
  const out: DraftRatings = {}
  for (const it of items) {
    if (needsRating(it)) out[it.questionNumber] = null
    else if (it.state === 'locked' || it.state === 'approved') out[it.questionNumber] = 'full'
  }
  return out
}

export function isChargeable(item: Pick<ReviewItem, 'state'>): boolean {
  return item.state === 'locked' || item.state === 'approved' || item.state === 'review'
}

/** Claude is still checking this card (a late verdict after End): not decided, so Settle waits for it. */
export function isPending(item: Pick<ReviewItem, 'state'>): boolean {
  return item.state === 'verifying'
}

/**
 * The review list kept current by live question updates. The fetched list (End / GET review) is a snapshot;
 * a verdict that lands after End changes the card, so state, quote and confidence come from the live
 * question. lockedCents stays the server's (it counts only backers who joined before the answer) unless the
 * card had no amount when the snapshot was taken. Cards missing from the snapshot are appended; hidden ones dropped.
 */
export function liveReview(items: readonly ReviewItemIn[] | null, questions: readonly (QuestionView & { quoteTruncated?: boolean })[]): ReviewItemIn[] | null {
  if (!items) return null
  const byId = new Map(questions.map((q) => [q.id, q]))
  const out: ReviewItemIn[] = []
  for (const it of items) {
    const q = byId.get(it.questionId)
    if (!q) {
      out.push(it)
      continue
    }
    if (q.state === 'hidden') continue
    const changed = q.state !== it.state
    out.push({
      ...it,
      state: q.state,
      quote: q.quote ?? (changed ? null : it.quote),
      // The ellipsis follows the live quote when one is shown; otherwise the snapshot's flag stays.
      ...(q.quote && typeof q.quoteTruncated === 'boolean' ? { quoteTruncated: q.quoteTruncated } : {}),
      confidence: q.confidence ?? (changed ? null : it.confidence),
      backers: it.lockedCents > 0 || !changed ? it.backers : q.backers,
      lockedCents: it.lockedCents > 0 || !changed ? it.lockedCents : q.backedCents,
    })
  }
  const known = new Set(items.map((i) => i.questionId))
  for (const q of questions) {
    if (known.has(q.id) || q.state === 'hidden') continue
    out.push({
      questionNumber: q.number,
      questionId: q.id,
      text: q.text,
      state: q.state,
      quote: q.quote,
      confidence: q.confidence,
      verdict: null,
      backers: q.backers,
      lockedCents: q.backedCents,
      ...(typeof q.quoteTruncated === 'boolean' ? { quoteTruncated: q.quoteTruncated } : {}),
    })
  }
  return out
}

/** The body for POST /api/rooms/:id/settle. Unrated -> 'none'. */
export function settleRatings(items: readonly ReviewItem[], draft: DraftRatings): Record<number, Rating> {
  const out: Record<number, Rating> = {}
  for (const it of items) {
    if (!isChargeable(it)) continue
    out[it.questionNumber] = draft[it.questionNumber] ?? 'none'
  }
  return out
}

/** Upper bound of what a rating can capture for one card (halves round down per backing, so this never under-states). */
export function maxChargeCents(lockedCents: number, rating: Rating | null): number {
  if (rating === 'full') return lockedCents
  if (rating === 'half') return Math.floor(lockedCents / 2)
  return 0
}

export function reviewSummary(items: readonly ReviewItemIn[], draft: DraftRatings) {
  const locks = items.filter((i) => (i.state === 'locked' || i.state === 'approved') && !needsRating(i)).length
  const partials = items.filter(needsRating)
  const unrated = partials.filter((i) => (draft[i.questionNumber] ?? null) === null).length
  const upToCents = items.reduce((sum, i) => sum + (isChargeable(i) ? maxChargeCents(i.lockedCents, draft[i.questionNumber] ?? null) : 0), 0)
  return { locks, partials: partials.length, unrated, upToCents }
}
