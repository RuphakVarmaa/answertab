// GET /api/rooms/:id/events: SSE. ?token= is the creator token or a fan token; no token gives the public stream.
import type { FastifyInstance } from 'fastify'
import type { RoomEvent } from '../../shared/types.js'
import { creatorTokenMatches, findFan, publicRoomView, requireRoom, unauthorizedError } from '../domain/index.js'
import { openStream, type Role } from '../sse.js'
import { limitIp, roomParams, type IdParams } from './http.js'

export async function eventRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: IdParams; Querystring: { token?: string } }>(
    '/api/rooms/:id/events',
    {
      // Keyed by IP alone: made-up tokens cannot buy extra connects.
      config: limitIp(120),
      schema: { params: roomParams, querystring: { type: 'object', properties: { token: { type: 'string', maxLength: 100 } } } },
    },
    async (req, reply) => {
      const room = await requireRoom(req.params.id)
      const token = req.query.token
      let role: Role = 'public'
      let fanId: string | null = null
      if (token) {
        if (creatorTokenMatches(room, token)) role = 'creator'
        else {
          const fan = await findFan(room.id, token)
          if (!fan) throw unauthorizedError('That token is not valid for this room.')
          role = 'fan'
          fanId = fan.id
        }
      }
      const initial: RoomEvent[] = [{ type: 'room.state', room: await publicRoomView(room.id) }]
      reply.hijack()
      const refused = openStream(reply.raw, { roomId: room.id, role, fanId, ip: req.ip, initial })
      if (refused) {
        reply.raw.writeHead(refused === 'too_many_viewers' ? 503 : 429, { 'Content-Type': 'application/json' })
        const message = refused === 'too_many_viewers' ? 'This room has too many live viewers.' : 'Too many live streams from this device or network for this room.'
        reply.raw.end(JSON.stringify({ error: { code: refused, message } }))
      }
    },
  )
}
