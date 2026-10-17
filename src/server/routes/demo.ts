import type { FastifyInstance } from 'fastify'
import { roomLinks } from '../domain/index.js'
import { startDemoRoom } from '../demo/index.js'
import { limitIp } from './http.js'

export async function demoRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { judgeCode?: string } }>(
    '/api/demo',
    {
      config: limitIp(6),
      schema: { body: { type: 'object', additionalProperties: false, properties: { judgeCode: { type: 'string', maxLength: 200 } } } },
    },
    async (req, reply) => {
      const r = await startDemoRoom({ judgeCode: req.body?.judgeCode, ip: req.ip })
      reply.code(201)
      return { ...r, ...roomLinks(r.roomId, r.creatorToken) }
    },
  )
}
