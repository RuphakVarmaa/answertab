// Unguessable IDs and tokens (base58, no lookalike characters).
import { randomBytes, createHash } from 'node:crypto'

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

export function base58(bytes: number): string {
  const buf = randomBytes(bytes)
  let out = ''
  for (const b of buf) out += ALPHABET[b % 58]
  return out
}

/** Short public IDs: rooms (10), rows (14). Tokens: 32 chars (~187 bits). */
export const newRoomId = () => base58(10)
export const newId = (prefix: string) => `${prefix}_${base58(14)}`
export const newToken = () => base58(32)

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}
