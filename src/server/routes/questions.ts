import type { FastifyInstance } from 'fastify'
import type { EvidenceSpan } from '../../shared/types.js'
import { backQuestion, hideQuestion, pointSpan, requireCreator, requireFan, roomOfQuestion, undoQuestion } from '../domain/index.js'
import { creatorToken, fanToken, limit, rowParams } from './http.js'

type QParams = { qid: string }
const params = rowParams('qid')
const int = { type: 'integer', minimum: 0, maximum: 1_000_000 } as const

export async function questionRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: QParams }>('/api/questions/:qid/back', { config: limit(30), schema: { params } }, async (req) => {
    const roomId = await roomOfQuestion(req.params.qid)
    const { fan } = await requireFan(roomId, fanToken(req))
    return backQuestion(req.params.qid, fan)
  })

  app.post<{ Params: QParams }>('/api/questions/:qid/hide', { schema: { params } }, async (req) => {
    await requireCreator(await roomOfQuestion(req.params.qid), creatorToken(req))
    return hideQuestion(req.params.qid)
  })

  app.post<{ Params: QParams }>('/api/questions/:qid/undo', { schema: { params } }, async (req) => {
    await requireCreator(await roomOfQuestion(req.params.qid), creatorToken(req))
    return undoQuestion(req.params.qid)
  })

  app.post<{ Params: QParams; Body: { span: EvidenceSpan } }>(
    '/api/questions/:qid/point',
    {
      schema: {
        params,
        body: {
          type: 'object',
          required: ['span'],
          additionalProperties: false,
          properties: {
            span: {
              type: 'object',
              required: ['startSeg', 'startWord', 'endSeg', 'endWord'],
              additionalProperties: false,
              properties: { startSeg: int, startWord: int, endSeg: int, endWord: int },
            },
          },
        },
      },
    },
    async (req) => {
      await requireCreator(await roomOfQuestion(req.params.qid), creatorToken(req))
      return pointSpan(req.params.qid, req.body.span)
    },
  )
}
