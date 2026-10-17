// Creator and fan tokens. The creator token is stored only as a sha256 hash and compared in constant time.
import { timingSafeEqual } from 'node:crypto'
import { config } from '../config.js'
import { db } from '../db/db.js'
import { sha256 } from '../ids.js'
import { forbidden, unauthorized } from './errors.js'
import type { FanRow, RoomRow } from './rows.js'
import { requireRoom } from './views.js'

const TOKEN_RE = /^[1-9A-HJ-NP-Za-km-z]{20,64}$/

export const looksLikeToken = (t: unknown): t is string => typeof t === 'string' && TOKEN_RE.test(t)

function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex')
  const bb = Buffer.from(b, 'hex')
  return ab.length > 0 && ab.length === bb.length && timingSafeEqual(ab, bb)
}

export function creatorTokenMatches(room: Pick<RoomRow, 'creator_token_hash'>, token: unknown): boolean {
  return looksLikeToken(token) && safeEqualHex(sha256(token), room.creator_token_hash)
}

export async function requireCreator(roomId: string, token: unknown): Promise<RoomRow> {
  if (!looksLikeToken(token)) throw unauthorized('Creator token required.')
  const room = await requireRoom(roomId)
  if (!creatorTokenMatches(room, token)) throw forbidden('wrong_token', 'That creator token is not valid for this room.')
  return room
}

export async function findFan(roomId: string, token: unknown): Promise<FanRow | null> {
  if (!looksLikeToken(token)) return null
  const rows = await db().query<FanRow>(`SELECT * FROM fans WHERE room_id = $1 AND fan_token = $2`, [roomId, token])
  const fan = rows[0]
  // The lookup is by unique index; the compare keeps the check explicit.
  if (!fan || !timingSafeEqual(Buffer.from(fan.fan_token), Buffer.from(token))) return null
  return fan
}

export async function requireFan(roomId: string, token: unknown): Promise<{ room: RoomRow; fan: FanRow }> {
  if (!looksLikeToken(token)) throw unauthorized('Fan token required.')
  const room = await requireRoom(roomId)
  const fan = await findFan(roomId, token)
  if (!fan) throw forbidden('wrong_token', 'That fan token is not valid for this room.')
  return { room, fan }
}

/** Constant-time judge code check. False when JUDGE_CODE is unset. */
export function judgeCodeMatches(code: unknown): boolean {
  const expected = config().judgeCode
  if (!expected || typeof code !== 'string' || code.length === 0 || code.length > 200) return false
  return safeEqualHex(sha256(code), sha256(expected))
}

export const ipHash = (ip: string): string => sha256(`ip:${ip}`)
