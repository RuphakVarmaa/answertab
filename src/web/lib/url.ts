// URL helpers. Identity lives in URLs: the creator key in the fragment (never sent to servers),
// the fan token in ?t=, receipts by unguessable token.

/** "#k=abc&fans=..." -> { k: 'abc', fans: '...' } */
export function parseHash(hash: string): Record<string, string> {
  const out: Record<string, string> = {}
  const body = hash.startsWith('#') ? hash.slice(1) : hash
  for (const part of body.split('&')) {
    if (!part) continue
    const eq = part.indexOf('=')
    const k = decodeURIComponent(eq === -1 ? part : part.slice(0, eq))
    const v = eq === -1 ? '' : decodeURIComponent(part.slice(eq + 1))
    if (k) out[k] = v
  }
  return out
}

export function buildHash(params: Record<string, string | undefined>): string {
  const parts = Object.entries(params)
    .filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
  return parts.length ? `#${parts.join('&')}` : ''
}

export const paths = {
  console: (room: string, key?: string) => `/c/${room}${key ? buildHash({ k: key }) : ''}`,
  fan: (room: string, fanToken?: string, extra: Record<string, string> = {}) => {
    const q = new URLSearchParams({ ...(fanToken ? { t: fanToken } : {}), ...extra }).toString()
    return `/f/${room}${q ? `?${q}` : ''}`
  },
  overlay: (room: string) => `/o/${room}`,
  receipt: (token: string) => `/r/${token}`,
  demo: (room: string, key?: string) => `/demo/${room}${key ? buildHash({ k: key }) : ''}`,
}

export function absolute(path: string, origin: string): string {
  return new URL(path, origin).toString()
}

/**
 * A judge link (`/?code=JUDGE_CODE`): the code, and the same URL without it (path, other params and hash kept)
 * so the page can drop it from the address bar. `cleaned` is null when there was no `code` param.
 */
export function takeJudgeCode(href: string): { code: string; cleaned: string | null } {
  const url = new URL(href)
  if (!url.searchParams.has('code')) return { code: '', cleaned: null }
  const code = (url.searchParams.get('code') ?? '').trim().slice(0, 200)
  url.searchParams.delete('code')
  return { code, cleaned: `${url.pathname}${url.search}${url.hash}` }
}
