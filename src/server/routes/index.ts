import type { FastifyInstance } from 'fastify'
import { demoRoutes } from './demo.js'
import { eventRoutes } from './events.js'
import { ledgerRoutes } from './ledger.js'
import { questionRoutes } from './questions.js'
import { receiptRoutes } from './receipts.js'
import { roomRoutes } from './rooms.js'
import { systemRoutes } from './system.js'
import { webhookRoutes } from './webhooks.js'

/** Registers every API route. Call after the rate-limit plugin so its onRoute hook sees them. */
export async function apiRoutes(app: FastifyInstance): Promise<void> {
  await app.register(systemRoutes)
  await app.register(roomRoutes)
  await app.register(questionRoutes)
  await app.register(receiptRoutes)
  await app.register(ledgerRoutes)
  await app.register(demoRoutes)
  await app.register(eventRoutes)
  // Encapsulated: its raw-body parser applies to this route only.
  await app.register(webhookRoutes)
}
