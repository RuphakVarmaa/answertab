// SSE hub: one stream per viewer, filtered by audience. Creator streams get everything; fan streams get public
// events plus their own tab and contests; anonymous streams (the overlay) get public events only.
import type { ServerResponse } from 'node:http'
import type { RoomEvent } from '../shared/types.js'
import { onRoomEvent, type Audience } from './domain/index.js'

export type Role = 'creator' | 'fan' | 'public'

interface Client {
  roomId: string
  role: Role
  fanId: string | null
  ip: string
  res: ServerResponse
}

export const HEARTBEAT_MS = 15_000
export const RETRY_MS = 3_000
/** Fan and overlay streams per room. Creator streams have their own cap, so viewers can never lock out the console. */
export const MAX_CLIENTS_PER_ROOM = 500
export const MAX_CREATOR_STREAMS_PER_ROOM = 20
export const MAX_STREAMS_PER_IP_PER_ROOM = 40
export const MAX_STREAMS_PER_FAN = 6

const rooms = new Map<string, Set<Client>>()
let unsubscribe: (() => void) | null = null
let heartbeat: ReturnType<typeof setInterval> | null = null

export function allowed(c: Pick<Client, 'role' | 'fanId'>, a: Audience): boolean {
  switch (a.to) {
    case 'all':
      return true
    case 'creator':
      return c.role === 'creator'
    case 'others':
      return c.role !== 'creator'
    case 'fan':
      return c.role === 'fan' && c.fanId === a.fanId
  }
}

function write(c: Client, chunk: string): void {
  if (c.res.writableEnded || c.res.destroyed) return
  c.res.write(chunk)
}

const frame = (e: RoomEvent) => `data: ${JSON.stringify(e)}\n\n`

export function startSseHub(): void {
  if (unsubscribe) return
  unsubscribe = onRoomEvent((roomId, event, audience) => {
    const set = rooms.get(roomId)
    if (!set) return
    const data = frame(event)
    for (const c of set) if (allowed(c, audience)) write(c, data)
  })
  heartbeat = setInterval(() => {
    for (const set of rooms.values()) for (const c of set) write(c, `: heartbeat ${Date.now()}\n\n`)
  }, HEARTBEAT_MS)
  heartbeat.unref()
}

export function stopSseHub(): void {
  unsubscribe?.()
  unsubscribe = null
  if (heartbeat) clearInterval(heartbeat)
  heartbeat = null
  for (const set of rooms.values()) for (const c of set) c.res.end()
  rooms.clear()
}

export function clientCount(roomId: string): number {
  return rooms.get(roomId)?.size ?? 0
}

export type StreamRefusal = 'too_many_viewers' | 'too_many_streams'

function admit(set: Set<Client>, p: { role: Role; fanId: string | null; ip: string }): StreamRefusal | null {
  let creators = 0
  let viewers = 0
  let sameIp = 0
  let sameFan = 0
  for (const c of set) {
    if (c.role === 'creator') creators++
    else viewers++
    if (c.ip === p.ip && c.role !== 'creator') sameIp++
    if (p.fanId !== null && c.fanId === p.fanId) sameFan++
  }
  if (p.role === 'creator') return creators >= MAX_CREATOR_STREAMS_PER_ROOM ? 'too_many_streams' : null
  if (sameIp >= MAX_STREAMS_PER_IP_PER_ROOM || sameFan >= MAX_STREAMS_PER_FAN) return 'too_many_streams'
  return viewers >= MAX_CLIENTS_PER_ROOM ? 'too_many_viewers' : null
}

/** Takes over the raw response. `initial` events are sent first (the client reloads state on reconnect anyway). */
export function openStream(
  res: ServerResponse,
  p: { roomId: string; role: Role; fanId: string | null; ip?: string; initial: RoomEvent[]; onClose?: () => void },
): StreamRefusal | null {
  const set = rooms.get(p.roomId) ?? new Set<Client>()
  const ip = p.ip ?? '-'
  const refused = admit(set, { role: p.role, fanId: p.fanId, ip })
  if (refused) return refused
  rooms.set(p.roomId, set)
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff',
  })
  const c: Client = { roomId: p.roomId, role: p.role, fanId: p.fanId, ip, res }
  set.add(c)
  write(c, `retry: ${RETRY_MS}\n\n`)
  for (const e of p.initial) write(c, frame(e))
  res.on('close', () => {
    set.delete(c)
    if (set.size === 0) rooms.delete(p.roomId)
    p.onClose?.()
  })
  return null
}
