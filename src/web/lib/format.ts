// Display formatting. Pure: imported by node tests, so no DOM here.
import { formatCents } from '../../shared/money.js'

/** formatCents, optionally dropping ".00" for whole dollars ("$12" instead of "$12.00"). */
export function money(cents: number, opts: { compact?: boolean } = {}): string {
  const s = formatCents(cents)
  return opts.compact && s.endsWith('.00') ? s.slice(0, -3) : s
}

/** Room-clock milliseconds as "m:ss" (or "h:mm:ss"). Negative or missing values read "0:00". */
export function formatClock(ms: number | null | undefined): string {
  const total = Math.max(0, Math.floor((ms ?? 0) / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** "just now", "3 min ago", "2 h ago", "4 d ago". */
export function timeAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return 'never'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return 'unknown'
  const s = Math.round((now - t) / 1000)
  if (s < 0) return 'just now'
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86_400)} d ago`
}

/** "in 9 min", "in 40 s", "now" for a future deadline. */
export function timeUntil(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const s = Math.round((t - now) / 1000)
  if (s <= 0) return 'now'
  if (s < 90) return `in ${s} s`
  if (s < 5400) return `in ${Math.round(s / 60)} min`
  return `in ${Math.round(s / 3600)} h`
}

export function percent(part: number, whole: number, digits = 0): string {
  if (whole <= 0) return '0%'
  return `${((part / whole) * 100).toFixed(digits)}%`
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

export const SOURCE_LABEL = { spoken: 'Spoken', typed: 'Typed', replay: 'Replay' } as const

/**
 * The server marks a quote whose evidence span stops before the end of its segment (`quoteTruncated`, on
 * QuestionView, ReviewItem and ReceiptLine; absent on older servers). Only an explicit true counts.
 */
export function isQuoteTruncated(x: object | null | undefined): boolean {
  return !!x && (x as { quoteTruncated?: unknown }).quoteTruncated === true
}

/** A truncated quote reads as continuing: one ellipsis after the cut words, never doubled, never after a finished sentence. */
export function quoteEllipsis(text: string, truncated: boolean): string {
  return truncated && !/(…|[.!?]["')\]]?)\s*$/.test(text) ? '…' : ''
}
