import type { FastifyInstance } from 'fastify'
import { contestRoomId, createContest, decideContest, getReceipt, requireCreator, verifyReceipt, VERIFY_EVERY_MS } from '../domain/index.js'
import { creatorToken, limit, limitIp, rowParams, tokenParams } from './http.js'

type TParams = { token: string }

export async function receiptRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: TParams }>('/api/receipts/:token', { config: limitIp(60), schema: { params: tokenParams } }, async (req) => getReceipt(req.params.token))

  app.post<{ Params: TParams }>(
    '/api/receipts/:token/verify',
    {
      // One live PayPal re-read per receipt per 10 s (the domain enforces the same per tab).
      config: { rateLimit: { max: 1, timeWindow: VERIFY_EVERY_MS, keyGenerator: (req) => `verify:${(req.params as TParams).token}` } },
      schema: { params: tokenParams },
    },
    async (req) => verifyReceipt(req.params.token),
  )

  app.post<{ Params: TParams; Body: { backingId: string; reason: string } }>(
    '/api/receipts/:token/contest',
    {
      config: limitIp(10),
      schema: {
        params: tokenParams,
        body: {
          type: 'object',
          required: ['backingId', 'reason'],
          additionalProperties: false,
          properties: { backingId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' }, reason: { type: 'string', maxLength: 1000 } },
        },
      },
    },
    async (req, reply) => {
      const c = await createContest(req.params.token, req.body)
      reply.code(201)
      return c
    },
  )

  app.post<{ Params: { id: string }; Body: { approve: boolean } }>(
    '/api/contests/:id/decide',
    {
      config: limit(20),
      schema: {
        params: rowParams('id'),
        body: { type: 'object', required: ['approve'], additionalProperties: false, properties: { approve: { type: 'boolean' } } },
      },
    },
    async (req) => {
      await requireCreator(await contestRoomId(req.params.id), creatorToken(req))
      return decideContest(req.params.id, req.body.approve)
    },
  )
}
