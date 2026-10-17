// SSE subscription for a room. Reconnects with backoff when the browser gives up, and asks the page
// to reload full state on every (re)open so nothing missed while disconnected stays missing.
import { useEffect, useRef, useState } from 'react'
import type { RoomEvent } from '../../shared/types.js'
import { api, type Auth } from './api.js'
import { EVENT_TYPES, backoffMs, parseRoomEvent } from './events.js'

export type SseStatus = 'idle' | 'connecting' | 'open' | 'reconnecting'

export interface RoomEventsOptions {
  roomId: string
  auth: Auth
  enabled?: boolean
  onEvent: (ev: RoomEvent) => void
  /** Called on every open, including the first, and when the tab comes back after a long sleep. */
  onResync: () => void
}

const authKey = (a: Auth) => (!a ? '' : 'creator' in a ? `c:${a.creator}` : `f:${a.fan}`)

export function useRoomEvents({ roomId, auth, enabled = true, onEvent, onResync }: RoomEventsOptions): SseStatus {
  const [status, setStatus] = useState<SseStatus>('idle')
  const handlers = useRef({ onEvent, onResync })
  handlers.current = { onEvent, onResync }
  const key = authKey(auth)

  useEffect(() => {
    if (!enabled || !auth || typeof EventSource === 'undefined') {
      setStatus('idle')
      return
    }
    const url = api.eventsUrl(roomId, auth)
    let es: EventSource | null = null
    let attempt = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let disposed = false
    let hiddenAt: number | null = null

    const dispatch = (name: string) => (msg: MessageEvent<string>) => {
      const ev = parseRoomEvent(name, msg.data)
      if (ev) handlers.current.onEvent(ev)
    }

    const connect = () => {
      if (disposed) return
      clearTimeout(timer)
      es?.close()
      setStatus(attempt === 0 ? 'connecting' : 'reconnecting')
      const source = new EventSource(url)
      es = source
      source.onopen = () => {
        attempt = 0
        setStatus('open')
        handlers.current.onResync()
      }
      source.onmessage = dispatch('message')
      for (const t of EVENT_TYPES) source.addEventListener(t, dispatch(t) as EventListener)
      source.onerror = () => {
        if (disposed) return
        setStatus('reconnecting')
        // CONNECTING means the browser retries on its own (server sent retry: 3000). CLOSED means it gave up.
        if (source.readyState === EventSource.CLOSED) {
          source.close()
          timer = setTimeout(connect, backoffMs(attempt++))
        }
      }
    }

    const onOnline = () => {
      if (es?.readyState !== EventSource.OPEN) {
        attempt = 0
        connect()
      }
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') hiddenAt = Date.now()
      else if (hiddenAt && Date.now() - hiddenAt > 30_000) {
        hiddenAt = null
        if (es?.readyState === EventSource.OPEN) handlers.current.onResync()
        else onOnline()
      }
    }

    connect()
    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      disposed = true
      clearTimeout(timer)
      es?.close()
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVisibility)
    }
    // `key` stands in for `auth`, whose object identity changes every render.
  }, [roomId, key, enabled])

  return status
}
