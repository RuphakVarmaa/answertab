import type { FastifyInstance } from 'fastify'
import { ledgerCallRoom, replayLedgerCall, requireCreator } from '../domain/index.js'
import { creatorToken, limit, rowParams } from './http.js'

export async function ledgerRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { callId: string } }>('/api/ledger/:callId/replay', { config: limit(10), schema: { params: rowParams('callId') } }, async (req) => {
    await requireCreator(await ledgerCallRoom(req.params.callId), creatorToken(req))
    return replayLedgerCall(req.params.callId)
  })
}
