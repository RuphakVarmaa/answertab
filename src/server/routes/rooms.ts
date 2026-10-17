// Room, fan, tab, transcript, question and settlement routes. Every handler calls the domain layer only.
import type { FastifyInstance } from 'fastify'
import type { Funding, Rating, SegmentSource } from '../../shared/types.js'
import {
  addSegment,
  askQuestion,
  authorizeTab,
  closeContestWindow,
  createRoom,
  endRoom,
  getConsoleView,
  getMe,
  getReview,
  joinRoom,
  openTabOrder,
  publicRoomView,
  receiptUrl,
  requireCreator,
  requireFan,
  roomLinks,
  roomQrPng,
  settleRoom,
  startRoom,
  updateRoomSettings,
  ROOM_LANGUAGES,
} from '../domain/index.js'
import { creatorToken, fanToken, limit, limitIp, roomParams, type IdParams } from './http.js'

export async function roomRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { title?: string; kind: 'demo' | 'public'; language?: string; judgeCode?: string } }>(
    '/api/rooms',
    {
      config: limitIp(10),
      schema: {
        body: {
          type: 'object',
          required: ['kind'],
          additionalProperties: false,
          properties: {
            title: { type: 'string', maxLength: 200 },
            kind: { type: 'string', enum: ['demo', 'public'] },
            language: { type: 'string', maxLength: 10 },
            judgeCode: { type: 'string', maxLength: 200 },
          },
        },
      },
    },
    async (req, reply) => {
      const r = await createRoom({ ...req.body, ip: req.ip })
      reply.code(201)
      return { roomId: r.roomId, creatorToken: r.creatorToken, pool: r.pool, ...roomLinks(r.roomId, r.creatorToken) }
    },
  )

  app.get<{ Params: IdParams }>('/api/rooms/:id', { schema: { params: roomParams } }, async (req) => publicRoomView(req.params.id))

  app.get<{ Params: IdParams }>('/api/rooms/:id/console', { schema: { params: roomParams } }, async (req) => {
    await requireCreator(req.params.id, creatorToken(req))
    return getConsoleView(req.params.id)
  })

  app.post<{ Params: IdParams }>('/api/rooms/:id/start', { schema: { params: roomParams } }, async (req) => {
    await requireCreator(req.params.id, creatorToken(req))
    return startRoom(req.params.id)
  })

  app.post<{ Params: IdParams; Body: { language?: string } }>(
    '/api/rooms/:id/settings',
    {
      config: limit(30),
      schema: {
        params: roomParams,
        body: { type: 'object', additionalProperties: false, properties: { language: { type: 'string', enum: [...ROOM_LANGUAGES] } } },
      },
    },
    async (req) => {
      await requireCreator(req.params.id, creatorToken(req))
      return updateRoomSettings(req.params.id, req.body ?? {})
    },
  )

  app.post<{ Params: IdParams; Body: { text: string; final: boolean; source: SegmentSource; lagMs?: number } }>(
    '/api/rooms/:id/segments',
    {
      config: limit(1200),
      schema: {
        params: roomParams,
        body: {
          type: 'object',
          required: ['text', 'final', 'source'],
          additionalProperties: false,
          properties: {
            text: { type: 'string', maxLength: 4000 },
            final: { type: 'boolean' },
            source: { type: 'string', enum: ['spoken', 'typed', 'replay'] },
            lagMs: { type: 'number' },
          },
        },
      },
    },
    async (req, reply) => {
      await requireCreator(req.params.id, creatorToken(req))
      const r = await addSegment(req.params.id, req.body)
      if (r.interim) reply.code(202)
      return r
    },
  )

  app.post<{ Params: IdParams; Body: { displayName: string } }>(
    '/api/rooms/:id/fans',
    {
      config: limitIp(60),
      schema: {
        params: roomParams,
        body: { type: 'object', required: ['displayName'], additionalProperties: false, properties: { displayName: { type: 'string', maxLength: 100 } } },
      },
    },
    async (req, reply) => {
      const fan = await joinRoom(req.params.id, req.body.displayName)
      reply.code(201)
      return fan
    },
  )

  app.post<{ Params: IdParams; Body: { ceilingCents: number; funding: Funding } }>(
    '/api/rooms/:id/tab/order',
    {
      config: limit(20),
      schema: {
        params: roomParams,
        body: {
          type: 'object',
          required: ['ceilingCents', 'funding'],
          additionalProperties: false,
          properties: { ceilingCents: { type: 'integer', minimum: 1 }, funding: { type: 'string', enum: ['card', 'paypal'] } },
        },
      },
    },
    async (req) => {
      const { fan } = await requireFan(req.params.id, fanToken(req))
      return openTabOrder(req.params.id, fan, req.body)
    },
  )

  app.post<{ Params: IdParams; Body: { orderId: string } }>(
    '/api/rooms/:id/tab/authorize',
    {
      config: limit(20),
      schema: {
        params: roomParams,
        body: { type: 'object', required: ['orderId'], additionalProperties: false, properties: { orderId: { type: 'string', pattern: '^[A-Z0-9]{5,40}$' } } },
      },
    },
    async (req) => {
      const { fan } = await requireFan(req.params.id, fanToken(req))
      return authorizeTab(req.params.id, fan, req.body.orderId)
    },
  )

  app.get<{ Params: IdParams }>('/api/rooms/:id/me', { schema: { params: roomParams } }, async (req) => {
    const { fan } = await requireFan(req.params.id, fanToken(req))
    const me = await getMe(req.params.id, fan)
    return { ...me, receiptUrl: me.tab?.receiptToken ? receiptUrl(me.tab.receiptToken) : null }
  })

  app.get<{ Params: IdParams }>('/api/rooms/:id/review', { schema: { params: roomParams } }, async (req) => {
    await requireCreator(req.params.id, creatorToken(req))
    return getReview(req.params.id)
  })

  app.get<{ Params: IdParams }>('/api/rooms/:id/qr', { config: limitIp(30), schema: { params: roomParams } }, async (req, reply) => {
    const png = await roomQrPng(req.params.id)
    reply.type('image/png').header('Cache-Control', 'public, max-age=3600')
    return png
  })

  app.post<{ Params: IdParams; Body: { text: string; checkSimilar?: boolean } }>(
    '/api/rooms/:id/questions',
    {
      config: limit(20),
      schema: {
        params: roomParams,
        body: {
          type: 'object',
          required: ['text'],
          additionalProperties: false,
          properties: { text: { type: 'string', maxLength: 1000 }, checkSimilar: { type: 'boolean' } },
        },
      },
    },
    async (req, reply) => {
      const { fan } = await requireFan(req.params.id, fanToken(req))
      const q = await askQuestion(req.params.id, fan, req.body)
      reply.code(201)
      return q
    },
  )

  app.post<{ Params: IdParams }>('/api/rooms/:id/end', { schema: { params: roomParams } }, async (req) => {
    await requireCreator(req.params.id, creatorToken(req))
    return endRoom(req.params.id)
  })

  app.post<{ Params: IdParams; Body: { ratings?: Record<string, Rating> } }>(
    '/api/rooms/:id/settle',
    {
      config: limit(10),
      schema: {
        params: roomParams,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ratings: {
              type: 'object',
              maxProperties: 500,
              patternProperties: { '^[0-9]{1,5}$': { type: 'string', enum: ['full', 'half', 'none'] } },
              additionalProperties: false,
            },
          },
        },
      },
    },
    async (req) => {
      await requireCreator(req.params.id, creatorToken(req))
      return settleRoom(req.params.id, req.body?.ratings ?? {})
    },
  )

  app.post<{ Params: IdParams }>('/api/rooms/:id/close-contest-window', { config: limit(10), schema: { params: roomParams } }, async (req) => {
    await requireCreator(req.params.id, creatorToken(req))
    const r = await closeContestWindow(req.params.id, { force: true })
    return { payout: r.payout }
  })
}
