// POST /webhooks/paypal: the raw body is kept byte-for-byte for signature verification (own content parser here).
import type { FastifyInstance } from 'fastify'
import { receiveWebhook } from '../domain/index.js'

/** PayPal events are a few KB; unverified ones are still stored, so keep this small. */
export const WEBHOOK_BODY_LIMIT = 128 * 1024

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.removeAllContentTypeParsers()
  app.addContentTypeParser('*', { parseAs: 'string', bodyLimit: WEBHOOK_BODY_LIMIT }, (_req, body, done) => done(null, body))
  app.post<{ Body: string }>('/webhooks/paypal', { bodyLimit: WEBHOOK_BODY_LIMIT, config: { rateLimit: { max: 240, timeWindow: 60_000, keyGenerator: (req) => `wh:${req.ip}` } } }, async (req) => {
    const raw = typeof req.body === 'string' ? req.body : ''
    const r = await receiveWebhook(req.headers, raw)
    return { received: true, duplicate: r.duplicate, verified: r.verified }
  })
}
