// Fans and tabs. One tab per fan per room. Tab state always comes from the AUTHORIZATION status, never the order:
// a processor decline is HTTP 201 with the order COMPLETED and the authorization DENIED.
import type { AuthStatus, FanSelfView, Funding, TabState, TabView } from '../../shared/types.js'
import { db } from '../db/db.js'
import { newId, newToken } from '../ids.js'
import { authorizeOrder, createAuthorizeOrder, getOrder, isPayPalError, type TestCard } from '../paypal/index.js'
import { conflict, badRequest, notFound } from './errors.js'
import { backingView, num, tabView, type BackingRow, type FanRow, type RoomRow, type TabRow } from './rows.js'
import { cleanText } from './rooms.js'
import { emitTab, loadTabJoined, requireRoom } from './views.js'

export const MAX_FANS_PER_ROOM = 300

export async function joinRoom(roomId: string, displayName: unknown, opts: { isBot?: boolean } = {}): Promise<{ fanId: string; fanToken: string; displayName: string }> {
  const room = await requireRoom(roomId)
  if (room.status !== 'draft' && room.status !== 'live') throw conflict('room_closed', 'This stream has ended; new fans cannot join.')
  const name = cleanText(displayName, 32)
  if (name.length < 1) throw badRequest('bad_name', 'Pick a display name.')
  const count = await db().query<{ n: number }>(`SELECT count(*)::int AS n FROM fans WHERE room_id = $1`, [roomId])
  if (num(count[0]?.n) >= MAX_FANS_PER_ROOM) throw conflict('room_full', 'This room is full.')
  const fanId = newId('fan')
  const fanToken = newToken()
  await db().query(`INSERT INTO fans (id, room_id, display_name, fan_token, is_bot) VALUES ($1,$2,$3,$4,$5)`, [fanId, roomId, name, fanToken, opts.isBot === true])
  return { fanId, fanToken, displayName: name }
}

export async function getMe(roomId: string, fan: FanRow): Promise<FanSelfView> {
  const tab = await loadTabJoined('fan', fan.id, roomId)
  const backings = await db().query<BackingRow & { question_number: number }>(
    `SELECT b.*, q.number AS question_number, q.answer_start_ms FROM backings b JOIN questions q ON q.id = b.question_id
     WHERE b.fan_id = $1 AND b.room_id = $2 ORDER BY q.number`,
    [fan.id, roomId],
  )
  return { fanId: fan.id, displayName: fan.display_name, tab: tab ? tabView(tab) : null, backings: backings.map(backingView) }
}

/** Retry suffix after a 4xx: count this tab's earlier refused calls of that kind (from the ledger). */
async function refusedCalls(tabId: string, op: string): Promise<number> {
  const rows = await db().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM paypal_calls WHERE tab_id = $1 AND op = $2 AND http_status BETWEEN 400 AND 499`,
    [tabId, op],
  )
  return num(rows[0]?.n)
}

async function ensureTab(room: RoomRow, fanId: string, ceilingCents: number, funding: Funding): Promise<TabRow> {
  const rows = await db().query<TabRow>(
    `INSERT INTO tabs (id, room_id, fan_id, ceiling_cents, funding) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (room_id, fan_id) DO NOTHING RETURNING *`,
    [newId('tab'), room.id, fanId, ceilingCents, funding],
  )
  if (rows[0]) return rows[0]
  const [existing] = await db().query<TabRow>(`SELECT * FROM tabs WHERE room_id = $1 AND fan_id = $2`, [room.id, fanId])
  return existing!
}

function checkOpenable(room: RoomRow, ceilingCents: number): void {
  if (room.status !== 'draft' && room.status !== 'live') throw conflict('room_closed', 'This stream has ended; tabs are closed.')
  const ceilings = (Array.isArray(room.ceilings_cents) ? room.ceilings_cents : []).map(Number)
  if (!ceilings.includes(ceilingCents)) throw badRequest('bad_ceiling', `Pick one of the room's tab sizes (${ceilings.join(', ')} cents).`)
}

/**
 * Step 1 of a card or PayPal tab: create the AUTHORIZE order the browser approves. Idempotent per fan. Until an
 * authorization exists the fan can still change the size or the payment method: the row is updated and a new order
 * is created with the next -a{n} request-id suffix (the old order is simply never authorized).
 */
export async function openTabOrder(roomId: string, fan: FanRow, p: { ceilingCents: number; funding: Funding }): Promise<{ orderId: string; tab: TabView }> {
  const room = await requireRoom(roomId)
  if (p.funding !== 'card' && p.funding !== 'paypal') throw badRequest('bad_funding', 'Funding must be card or paypal.')
  checkOpenable(room, p.ceilingCents)
  let tab = await ensureTab(room, fan.id, p.ceilingCents, p.funding)
  if (tab.state !== 'opening' || tab.authorization_id) throw conflict('tab_exists', 'You already have a tab in this room (one per stream, no top-ups).')
  if (tab.ceiling_cents !== p.ceilingCents || tab.funding !== p.funding) {
    const [changed] = await db().query<TabRow>(
      `UPDATE tabs SET ceiling_cents = $2, funding = $3, order_id = NULL, order_attempt = order_attempt + 1
       WHERE id = $1 AND state = 'opening' AND authorization_id IS NULL RETURNING *`,
      [tab.id, p.ceilingCents, p.funding],
    )
    if (!changed) throw conflict('tab_exists', 'Your hold was just placed, so its size and payment method can no longer change.')
    tab = changed
  }
  if (tab.order_id) {
    const v = await loadTabJoined('id', tab.id)
    return { orderId: tab.order_id, tab: tabView(v!) }
  }
  const attempt = tab.order_attempt + (await refusedCalls(tab.id, 'orders.create'))
  const res = await createAuthorizeOrder({ roomId, fanId: fan.id, ceilingCents: p.ceilingCents, funding: p.funding, ...(attempt > 0 ? { attempt } : {}) })
  await db().query(`UPDATE tabs SET order_id = $2 WHERE id = $1 AND order_id IS NULL`, [tab.id, res.orderId])
  if (res.authorizationId && res.authStatus) {
    await applyAuthorization(tab.id, { authorizationId: res.authorizationId, authStatus: res.authStatus, expiresAt: res.expiresAt, declineReason: res.declineReason })
  } else {
    await emitTab(tab.id)
  }
  const v = await loadTabJoined('id', tab.id)
  return { orderId: v?.order_id ?? res.orderId, tab: tabView(v!) }
}

function stateFor(status: AuthStatus): TabState {
  switch (status) {
    case 'CREATED':
      return 'held'
    case 'DENIED':
      return 'declined'
    case 'PENDING':
      return 'opening'
    case 'VOIDED':
      return 'voided'
    case 'CAPTURED':
    case 'PARTIALLY_CAPTURED':
      return 'captured'
    default:
      return 'failed'
  }
}

/** Store an authorization result. The receipt token is minted when the hold is placed. */
export async function applyAuthorization(
  tabId: string,
  a: { authorizationId: string; authStatus: AuthStatus; expiresAt?: string | undefined; declineReason?: string | undefined },
): Promise<void> {
  const state = stateFor(a.authStatus)
  await db().query(
    `UPDATE tabs SET authorization_id = $2, auth_status = $3, auth_expires_at = $4, state = $5,
       decline_reason = $6, receipt_token = CASE WHEN $5 = 'held' THEN COALESCE(receipt_token, $7) ELSE receipt_token END
     WHERE id = $1 AND state = 'opening'`,
    [
      tabId, a.authorizationId, a.authStatus, a.expiresAt ? new Date(a.expiresAt) : null, state,
      state === 'declined' ? (a.declineReason ?? 'Declined by the processor (sandbox test), not charged.') : null, newToken(),
    ],
  )
  await emitTab(tabId)
}

/** Step 2: after the browser approved the order (card fields or PayPal button), place the hold. */
export async function authorizeTab(roomId: string, fan: FanRow, orderId: string): Promise<TabView> {
  const [tab] = await db().query<TabRow>(`SELECT * FROM tabs WHERE room_id = $1 AND fan_id = $2`, [roomId, fan.id])
  if (!tab) throw notFound('no_tab', 'Open a tab first.')
  if (tab.order_id !== orderId) throw badRequest('wrong_order', 'That order does not belong to your tab.')
  if (tab.state !== 'opening') return tabView((await loadTabJoined('id', tab.id))!)
  const room = await requireRoom(roomId)
  if (room.status !== 'draft' && room.status !== 'live') throw conflict('room_closed', 'This stream has ended, so no hold was placed.')
  // A re-ordered tab authorizes a different order, so it never reuses an earlier order's request id.
  const attempt = tab.order_attempt + (await refusedCalls(tab.id, 'orders.authorize'))
  try {
    const a = await authorizeOrder({ roomId, fanId: fan.id, orderId, ...(attempt > 0 ? { attempt } : {}) })
    await applyAuthorization(tab.id, a)
  } catch (e) {
    if (!isPayPalError(e)) throw e
    // Lost response or "already authorized": the order itself says what happened.
    const order = await getOrder(orderId, { roomId, fanId: fan.id, tabId: tab.id }).catch(() => null)
    if (order?.authorizationId && order.authStatus) {
      await applyAuthorization(tab.id, { authorizationId: order.authorizationId, authStatus: order.authStatus, expiresAt: order.expiresAt, declineReason: order.declineReason })
    } else if (e.issue === 'ORDER_NOT_APPROVED' || e.issue === 'PAYER_ACTION_REQUIRED') {
      throw conflict('order_not_approved', 'Finish the card or PayPal step first, then place the hold.')
    } else {
      throw e
    }
  }
  return tabView((await loadTabJoined('id', tab.id))!)
}

/** Bot fans (sandbox only): one Orders call with a published test card returns the authorization directly. */
export async function openBotTab(roomId: string, fanId: string, p: { ceilingCents: number; card: TestCard }): Promise<TabView> {
  const room = await requireRoom(roomId)
  checkOpenable(room, p.ceilingCents)
  const tab = await ensureTab(room, fanId, p.ceilingCents, 'bot_card')
  if (tab.state === 'opening') {
    try {
      const res = await createAuthorizeOrder({ roomId, fanId, ceilingCents: p.ceilingCents, funding: 'bot_card', botCard: p.card })
      await db().query(`UPDATE tabs SET order_id = $2 WHERE id = $1`, [tab.id, res.orderId])
      if (res.authorizationId && res.authStatus) {
        await applyAuthorization(tab.id, { authorizationId: res.authorizationId, authStatus: res.authStatus, expiresAt: res.expiresAt, declineReason: res.declineReason })
      } else {
        await db().query(`UPDATE tabs SET state = 'failed', decline_reason = 'PayPal returned no authorization' WHERE id = $1`, [tab.id])
        await emitTab(tab.id)
      }
    } catch (e) {
      await db().query(`UPDATE tabs SET state = 'failed', decline_reason = $2 WHERE id = $1 AND state = 'opening'`, [
        tab.id,
        isPayPalError(e) ? `PayPal error ${e.name}${e.issue ? `/${e.issue}` : ''}` : 'Could not open the tab',
      ])
      await emitTab(tab.id)
      throw e
    }
  }
  return tabView((await loadTabJoined('id', tab.id))!)
}
