// Route helpers: token headers, param schemas and per-route rate limits.
import type { FastifyRequest } from 'fastify'

export function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name]
  return Array.isArray(v) ? v[0] : v
}

export const creatorToken = (req: FastifyRequest) => header(req, 'x-creator-token')
export const fanToken = (req: FastifyRequest) => header(req, 'x-fan-token')

const ROOM_ID = { type: 'string', pattern: '^[1-9A-HJ-NP-Za-km-z]{10}$' } as const
const ROW_ID = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' } as const
const TOKEN = { type: 'string', pattern: '^[1-9A-HJ-NP-Za-km-z]{20,64}$' } as const

export const roomParams = { type: 'object', required: ['id'], properties: { id: ROOM_ID } } as const
export const rowParams = (name: string) => ({ type: 'object', required: [name], properties: { [name]: ROW_ID } }) as const
export const tokenParams = { type: 'object', required: ['token'], properties: { token: TOKEN } } as const

/** Per-route limit: `max` requests per `windowMs`, keyed by IP plus token (the global key). */
export const limit = (max: number, windowMs = 60_000) => ({ rateLimit: { max, timeWindow: windowMs } })

/** For routes that take no token: keyed by IP alone, so made-up token headers cannot reset the count. */
export const limitIp = (max: number, windowMs = 60_000) => ({ rateLimit: { max, timeWindow: windowMs, keyGenerator: (req: FastifyRequest) => `ip:${req.ip}` } })

export type IdParams = { id: string }
