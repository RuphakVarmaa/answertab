// One error type for every PayPal failure. Raw SDK, axios and fetch errors never leave src/server/paypal.

export interface PayPalErrorDetail {
  issue: string
  description?: string
  field?: string
  location?: string
}

export class PayPalError extends Error {
  /** PayPal's error name (e.g. UNPROCESSABLE_ENTITY), or NETWORK_ERROR / TIMEOUT / INVALID_ARGUMENT / ... for local failures. */
  override name: string
  /** 0 when no HTTP response was received. */
  readonly httpStatus: number
  readonly debugId: string | null
  readonly details: PayPalErrorDetail[]
  /** The first details[].issue, e.g. AUTHORIZATION_ALREADY_CAPTURED. */
  readonly issue: string | null
  /** HATEOAS links from the error body (e.g. a duplicate payout points at the original batch). */
  readonly links: { href: string; rel: string }[]

  constructor(p: {
    name: string
    message: string
    httpStatus: number
    debugId?: string | null
    details?: PayPalErrorDetail[]
    issue?: string | null
    links?: { href: string; rel: string }[]
  }) {
    super(p.message)
    this.name = p.name
    this.httpStatus = p.httpStatus
    this.debugId = p.debugId ?? null
    this.details = p.details ?? []
    this.issue = p.issue ?? this.details[0]?.issue ?? null
    this.links = p.links ?? []
    Object.setPrototypeOf(this, PayPalError.prototype)
  }

  toJSON() {
    return { name: this.name, message: this.message, httpStatus: this.httpStatus, debugId: this.debugId, issue: this.issue, details: this.details }
  }
}

export function isPayPalError(e: unknown): e is PayPalError {
  return e instanceof PayPalError
}

export function localError(name: string, message: string): PayPalError {
  return new PayPalError({ name, message, httpStatus: 0 })
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

export function parseJsonSafe(text: unknown): unknown {
  if (typeof text !== 'string' || text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function header(headers: Record<string, unknown> | undefined, name: string): string | undefined {
  if (!headers) return undefined
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name) return Array.isArray(v) ? str(v[0]) : str(v)
  }
  return undefined
}

/** Build a PayPalError from an HTTP error response. Handles REST errors, OAuth errors and empty bodies. */
export function fromHttpResponse(status: number, body: unknown, headers?: Record<string, unknown>): PayPalError {
  const b = isObj(body) ? body : {}
  const details: PayPalErrorDetail[] = Array.isArray(b.details)
    ? b.details.filter(isObj).map((d) => ({
        issue: str(d.issue) ?? 'UNKNOWN',
        ...(str(d.description) ? { description: str(d.description) } : {}),
        ...(str(d.field) ? { field: str(d.field) } : {}),
        ...(str(d.location) ? { location: str(d.location) } : {}),
      }))
    : []
  return new PayPalError({
    name: str(b.name) ?? str(b.error) ?? `HTTP_${status}`,
    message: str(b.message) ?? str(b.error_description) ?? `PayPal returned HTTP ${status}`,
    httpStatus: status,
    // The response header is the request's canonical debug id; mocked error bodies can carry a different one.
    debugId: header(headers, 'paypal-debug-id') ?? str(b.debug_id) ?? null,
    details,
    issue: details[0]?.issue ?? str(b.error) ?? null,
    links: collectLinks(b),
  })
}

/** Top-level links plus links nested in details (Payouts puts the original batch under details[].link). */
function collectLinks(b: Obj): { href: string; rel: string }[] {
  const raw: unknown[] = [
    ...(Array.isArray(b.links) ? b.links : []),
    ...(Array.isArray(b.details) ? b.details.filter(isObj).flatMap((d) => [...(Array.isArray(d.link) ? d.link : []), ...(Array.isArray(d.links) ? d.links : [])]) : []),
  ]
  return raw.filter(isObj).map((l) => ({ href: str(l.href) ?? '', rel: str(l.rel) ?? '' })).filter((l) => l.href !== '')
}

/** Map anything thrown by the Server SDK, fetch, the Agent Toolkit or our own code to a PayPalError. */
export function toPayPalError(e: unknown): PayPalError {
  if (e instanceof PayPalError) return e
  if (isObj(e) || e instanceof Error) {
    const o = e as Obj
    // APIMatic ApiError / ResponseValidationError: { statusCode, headers, body }
    if (typeof o.statusCode === 'number') {
      const parsed = typeof o.body === 'string' ? parseJsonSafe(o.body) : isObj(o.result) ? o.result : null
      return fromHttpResponse(o.statusCode, parsed, isObj(o.headers) ? o.headers : undefined)
    }
    // Agent Toolkit LlmError JSON: { ok: false, status, code, message }
    if (o.ok === false && typeof o.code === 'string') {
      return new PayPalError({ name: o.code, message: str(o.message) ?? 'Agent Toolkit error', httpStatus: typeof o.status === 'number' ? o.status : 0 })
    }
    if (isObj(o.error) && o.error.type === 'paypal_error') {
      return new PayPalError({ name: 'TOOLKIT_ERROR', message: str(o.error.message) ?? 'Agent Toolkit error', httpStatus: 0 })
    }
    const name = e instanceof Error ? e.name : ''
    const message = e instanceof Error ? e.message : String(o.message ?? 'unknown error')
    const code = typeof o.code === 'string' ? o.code : ''
    // httpStatus 0 on a write means the outcome is unknown: GET the resource before retrying.
    if (name === 'TimeoutError' || name === 'AbortError' || code === 'ECONNABORTED' || code === 'ETIMEDOUT' || /^timeout of \d+ms exceeded/.test(message)) {
      return new PayPalError({ name: 'TIMEOUT', message: 'PayPal request timed out', httpStatus: 0 })
    }
    if ((e instanceof TypeError && /fetch failed|network/i.test(message)) || ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'].includes(code)) {
      return new PayPalError({ name: 'NETWORK_ERROR', message: 'Could not reach PayPal', httpStatus: 0 })
    }
    return new PayPalError({ name: 'INTERNAL_ERROR', message: message.slice(0, 300), httpStatus: 0 })
  }
  return new PayPalError({ name: 'INTERNAL_ERROR', message: String(e).slice(0, 300), httpStatus: 0 })
}
