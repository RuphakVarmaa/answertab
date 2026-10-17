// Small, deterministic text helpers shared by the guard, prefilter, intake fallback and eval.

/** ARCHITECTURE: `segments.words` is `text.split(/\s+/)` after trimming. */
export function wordsOf(text: string): string[] {
  const t = text.trim()
  return t === '' ? [] : t.split(/\s+/)
}

/** Lowercase, keep letters/digits (any script), drop everything else. */
export function normToken(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/** Very light stemmer so "tests"/"testing"/"tested" match "test". */
export function stem(token: string): string {
  if (token.length > 5 && token.endsWith('ing')) return token.slice(0, -3)
  if (token.length > 4 && token.endsWith('ed')) return token.slice(0, -2)
  if (token.length > 4 && token.endsWith('es')) return token.slice(0, -2)
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1)
  return token
}

const STOP = new Set(
  `a an the and or but if then so to of in on at by for with from into onto over under about as is are was were be been being
  am do does did doing have has had having i me my mine you your yours we us our they them their it its this that these those
  there here what which who whom whose when where why how can could should would will shall may might must not no yes yeah
  just very really also too than more most some any all each other such only own same s t don dont im ive id youre thats
  whats lets let okay ok um uh like well right now gonna wanna kind sort thing things get got go going one up out`
    .split(/\s+/)
    .filter(Boolean),
)

/** Words that frame a question rather than answer it ("someone asked ..."). */
const META = new Set(
  `question questions asked ask asks asking someone somebody great good nice cool awesome thanks thank says said say saying
  next number q answer answering wonder wondering wants want wanted know`
    .split(/\s+/)
    .filter(Boolean),
)

export function isStopword(token: string): boolean {
  return STOP.has(token)
}

/** Content tokens: normalized, stemmed, minus stopwords and 1-letter tokens. */
export function contentTokens(text: string | string[], opts: { dropMeta?: boolean } = {}): string[] {
  const words = Array.isArray(text) ? text : wordsOf(text.replace(/[-/]/g, ' '))
  const out: string[] = []
  for (const w of words) {
    for (const part of w.split(/[-/]/)) {
      const n = normToken(part)
      if (n.length < 2 || STOP.has(n)) continue
      if (opts.dropMeta && META.has(n)) continue
      out.push(stem(n))
    }
  }
  return out
}

/** Normalized text for phrase matching: lowercase words joined by single spaces. */
export function normPhrase(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}#]+/gu, ' ')
    .trim()
}

export function jaccard(a: string[], b: string[]): number {
  const A = new Set(a)
  const B = new Set(b)
  if (A.size === 0 && B.size === 0) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return inter / (A.size + B.size - inter)
}
