// Domain errors carry an HTTP status and a stable code; the routes turn them into { error: { code, message } }.
import { isPayPalError } from '../paypal/index.js'

export class DomainError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'DomainError'
  }
}

export const badRequest = (code: string, message: string, extra?: Record<string, unknown>) => new DomainError(400, code, message, extra)
export const unauthorized = (message = 'Missing or invalid token.') => new DomainError(401, 'unauthorized', message)
export const forbidden = (code: string, message: string) => new DomainError(403, code, message)
export const notFound = (code: string, message: string) => new DomainError(404, code, message)
export const conflict = (code: string, message: string, extra?: Record<string, unknown>) => new DomainError(409, code, message, extra)
export const unprocessable = (code: string, message: string, extra?: Record<string, unknown>) => new DomainError(422, code, message, extra)
export const tooMany = (code: string, message: string) => new DomainError(429, code, message)

/** Any thrown value -> HTTP status + error body. PayPal failures surface as 502 with PayPal's debug id. */
export function toHttpError(e: unknown): { status: number; body: { error: Record<string, unknown> & { code: string; message: string } } } {
  if (e instanceof DomainError) return { status: e.status, body: { error: { code: e.code, message: e.message, ...e.extra } } }
  if (isPayPalError(e)) {
    const what = e.issue ? `${e.name}/${e.issue}` : e.name
    return {
      status: 502,
      body: { error: { code: 'paypal_error', message: `PayPal: ${what}: ${e.message}`.slice(0, 400), paypalName: e.name, paypalIssue: e.issue, debugId: e.debugId } },
    }
  }
  return { status: 500, body: { error: { code: 'internal', message: 'Something went wrong on our side.' } } }
}
