// Deep redaction for anything written to the ledger, logs or returned as `raw`.
// Removes card data, credentials and tokens, payer phone/address/name; masks email addresses.

const REDACTED = '[redacted]'

/** Keys whose values are always removed, wherever they appear. */
const DROP_KEYS = new Set([
  'number',
  'card_number',
  'security_code',
  'cvv',
  'cvv2',
  'cvc',
  'expiry',
  'authorization',
  'paypal-auth-assertion',
  'cookie',
  'access_token',
  'refresh_token',
  'id_token',
  'client_secret',
  'password',
  'nonce',
  'token',
  'single_use_token',
  'vault_id',
  'phone',
  'phone_number',
  'national_number',
  'address',
  'billing_address',
  'shipping_address',
  'birth_date',
  'tax_info',
  'given_name',
  'surname',
  'full_name',
])

/** Keys that hold an email address; the value is masked, not dropped. */
const EMAIL_KEYS = new Set(['email_address', 'email', 'receiver', 'payer_email'])

/** Objects under these keys describe a person or card; their `name` is PII. */
const PERSON_KEYS = new Set(['card', 'payer', 'shipping', 'paypal', 'venmo', 'payer_info', 'payee_info', 'buyer'])

/** Sandbox processor-trigger names (e.g. CCREJECT-REFUSED) are test data the ledger should show. */
const SANDBOX_TRIGGER_NAME = /^CCREJECT-[A-Z_]+$/

export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@')
  if (at <= 0) return REDACTED
  return `${email.slice(0, Math.min(4, at))}***${email.slice(at)}`
}

function luhnValid(digits: string): boolean {
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

/** Scrubs secrets that can hide inside free text (error messages, notes, URLs). */
export function scrubString(s: string): string {
  let out = s
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
    .replace(/\bA21AA[A-Za-z0-9_-]{20,}/g, REDACTED)
  out = out.replace(/\b\d(?:[ -]?\d){12,18}\b/g, (m) => {
    const digits = m.replace(/[ -]/g, '')
    return digits.length >= 13 && digits.length <= 19 && luhnValid(digits) ? '[redacted-pan]' : m
  })
  return out
}

export function redact(value: unknown, parentKey = ''): unknown {
  if (typeof value === 'string') return scrubString(value)
  if (Array.isArray(value)) return value.map((v) => redact(v, parentKey))
  if (typeof value !== 'object' || value === null) return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = k.toLowerCase()
    if (DROP_KEYS.has(key)) {
      out[k] = REDACTED
    } else if (EMAIL_KEYS.has(key) && typeof v === 'string') {
      out[k] = maskEmail(v)
    } else if (key === 'name' && PERSON_KEYS.has(parentKey)) {
      out[k] = typeof v === 'string' && SANDBOX_TRIGGER_NAME.test(v) ? v : REDACTED
    } else {
      out[k] = redact(v, key)
    }
  }
  return out
}

/** Only these request headers are kept in the ledger (never Authorization). */
const KEEP_HEADERS = ['paypal-request-id', 'prefer', 'paypal-mock-response', 'content-type']

export function pickHeaders(headers: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers) return out
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase()
    if (KEEP_HEADERS.includes(key) && v !== undefined && v !== null) out[key] = String(v)
  }
  return out
}
