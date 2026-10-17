// Snapshot + event stream = live state. Reloads on SSE (re)open; events that land during a reload are
// buffered and replayed onto the fresh snapshot. Without auth it falls back to polling.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RoomEvent } from '../../shared/types.js'
import { toApiError, type ApiError, type Auth } from './api.js'
import { replayOnto } from './events.js'
import { useRoomEvents, type SseStatus } from './useRoomEvents.js'

/** Events from somewhere other than this page's own SSE stream (the presentation parent). Returns unsubscribe. */
export type ExternalSource = (onEvent: (ev: RoomEvent) => void, onResync: () => void) => () => void

export interface LiveStateOptions<S> {
  roomId: string
  auth: Auth
  enabled?: boolean
  load: () => Promise<S>
  apply: (state: S, ev: RoomEvent) => S
  /** Transient events (interim text, verdict notes, settle progress) the page handles itself. */
  onEvent?: (ev: RoomEvent) => void
  /** Poll interval when there is no SSE (no auth). */
  pollMs?: number
  /** Take events from here instead of opening an EventSource. */
  external?: ExternalSource
}

export interface LiveState<S> {
  data: S | null
  error: ApiError | null
  loading: boolean
  stream: SseStatus
  reload: () => Promise<void>
  setData: (fn: (s: S) => S) => void
}

export function useLiveState<S>(opts: LiveStateOptions<S>): LiveState<S> {
  const [data, setDataRaw] = useState<S | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [loading, setLoading] = useState(true)
  const ref = useRef(opts)
  ref.current = opts
  const inFlight = useRef<Promise<void> | null>(null)
  const buffer = useRef<RoomEvent[] | null>(null)
  const again = useRef(false)

  const reload = useCallback(async (): Promise<void> => {
    if (inFlight.current) {
      again.current = true
      return inFlight.current
    }
    buffer.current = []
    const run = (async () => {
      try {
        const snap = await ref.current.load()
        const buffered = buffer.current ?? []
        buffer.current = null
        setDataRaw(replayOnto(snap, buffered, ref.current.apply))
        setError(null)
      } catch (e) {
        buffer.current = null
        setError(toApiError(e))
      } finally {
        setLoading(false)
        inFlight.current = null
      }
      if (again.current) {
        again.current = false
        await reload()
      }
    })()
    inFlight.current = run
    return run
  }, [])

  const onEvent = useCallback((ev: RoomEvent) => {
    ref.current.onEvent?.(ev)
    if (buffer.current) buffer.current.push(ev)
    else setDataRaw((s) => (s === null ? s : ref.current.apply(s, ev)))
  }, [])

  const external = opts.external
  const sse = useRoomEvents({ roomId: opts.roomId, auth: opts.auth, enabled: (opts.enabled ?? true) && !external, onEvent, onResync: () => void reload() })
  useEffect(() => {
    if (!external || opts.enabled === false) return
    return external(onEvent, () => void reload())
  }, [external, opts.enabled, onEvent, reload])
  const stream: SseStatus = external ? 'open' : sse

  useEffect(() => {
    if (opts.enabled === false) return
    void reload()
  }, [opts.roomId, opts.enabled, reload])

  const hasAuth = !!opts.auth
  useEffect(() => {
    if (hasAuth || !opts.pollMs || opts.enabled === false) return
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void reload()
    }, opts.pollMs)
    return () => clearInterval(id)
  }, [hasAuth, opts.pollMs, opts.enabled, reload])

  const setData = useCallback((fn: (s: S) => S) => setDataRaw((s) => (s === null ? s : fn(s))), [])

  return { data, error, loading, stream, reload, setData }
}
