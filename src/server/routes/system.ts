import type { FastifyInstance } from 'fastify'
import { publicConfig } from '../domain/index.js'
import { getStatus, lastPassedRun } from '../status.js'

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', { config: { rateLimit: false } }, async () => ({ ok: true }))
  app.get('/api/status', async () => ({ checks: await getStatus(), lastPassedRun: await lastPassedRun() }))
  app.get('/api/config', async () => publicConfig())
}
