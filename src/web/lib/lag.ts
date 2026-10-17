// Recognition lag: how long after the creator stopped speaking the final transcript arrived.
// Chrome gives no word timings, so the last interim change stands in for "speech ended".
export const MAX_LAG_MS = 3000

export function estimateLagMs(p: { finalAt: number; lastInterimAt: number | null; speechStartAt: number | null }): number {
  const ref = p.lastInterimAt ?? p.speechStartAt ?? p.finalAt
  return Math.min(MAX_LAG_MS, Math.max(0, Math.round(p.finalAt - ref)))
}

/** Median of the recent samples, or null with none. */
export function medianMs(samples: readonly number[]): number | null {
  if (samples.length === 0) return null
  const s = samples.slice().sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2)
}
