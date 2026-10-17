// Per-tab memory for secrets that must not sit in the address bar. sessionStorage only (cleared when the
// tab closes), keyed per room. Identity that must survive lives in URLs, never in localStorage.
import { buildHash, parseHash } from './url.js'
import type { DemoRoom } from './api.js'

const creatorKey = (room: string) => `answertab:creator:${room}`
const demoKey = (room: string) => `answertab:demo:${room}`

function read(key: string): string | null {
  try {
    return sessionStorage.getItem(key)
  } catch {
    return null
  }
}
function write(key: string, value: string) {
  try {
    sessionStorage.setItem(key, value)
  } catch {
    /* private mode or blocked storage: the in-memory copy still works for this page */
  }
}

const memory = new Map<string, string>()

/**
 * Creator key from #k=..., else from this tab's memory. When it came from the fragment it is removed from
 * the address bar (so it does not show in screen recordings) and kept for this room only.
 */
export function takeCreatorToken(room: string): string | null {
  const fromHash = parseHash(window.location.hash).k
  if (fromHash) {
    memory.set(creatorKey(room), fromHash)
    write(creatorKey(room), fromHash)
    const { k: _secret, ...rest } = parseHash(window.location.hash)
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search + buildHash(rest))
    return fromHash
  }
  return memory.get(creatorKey(room)) ?? read(creatorKey(room))
}

export function rememberCreatorToken(room: string, token: string) {
  memory.set(creatorKey(room), token)
  write(creatorKey(room), token)
}

export type StripFan = DemoRoom['stripFans'][number]

export function rememberDemo(room: string, fans: StripFan[]) {
  const json = JSON.stringify(fans)
  memory.set(demoKey(room), json)
  write(demoKey(room), json)
}

export function readDemoFans(room: string): StripFan[] {
  const raw = memory.get(demoKey(room)) ?? read(demoKey(room))
  if (!raw) return []
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v)
      ? v.filter((f): f is StripFan => !!f && typeof f === 'object' && typeof (f as StripFan).fanToken === 'string' && typeof (f as StripFan).displayName === 'string')
      : []
  } catch {
    return []
  }
}
