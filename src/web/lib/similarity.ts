// A quick local "similar to #N?" hint while the fan types. The server's intake (Haiku) gives the real
// similarTo after posting; this only nudges toward backing instead of asking twice.
const STOP = new Set(
  'a an and are as at be but by can do does for from how i if in into is it its me my of on or should so that the their them then there these this to was we what when where which who why will with would you your about any some just get got have has had like vs versus'.split(
    ' ',
  ),
)

export function contentWords(text: string): Set<string> {
  const out = new Set<string>()
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3 || STOP.has(raw)) continue
    out.add(raw.length > 4 && raw.endsWith('s') ? raw.slice(0, -1) : raw)
  }
  return out
}

/** Best open question sharing at least two content words and half of the shorter one's words. */
export function similarQuestion(
  text: string,
  candidates: readonly { number: number; text: string }[],
): { number: number; score: number } | null {
  const mine = contentWords(text)
  if (mine.size < 2) return null
  let best: { number: number; score: number } | null = null
  for (const c of candidates) {
    const theirs = contentWords(c.text)
    if (theirs.size === 0) continue
    let shared = 0
    for (const w of mine) if (theirs.has(w)) shared++
    if (shared < 2) continue
    const score = shared / Math.min(mine.size, theirs.size)
    if (score >= 0.5 && (!best || score > best.score)) best = { number: c.number, score }
  }
  return best
}
