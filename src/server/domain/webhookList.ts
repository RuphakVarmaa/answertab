// Verified PayPal webhook events for one room's console list. Its own module so rooms.ts does not import the
// webhook handlers (which import contests, which import rooms).
import type { WebhookEventView } from '../../shared/types.js'
import { db } from '../db/db.js'

export async function roomWebhooks(roomId: string, limit = 50): Promise<WebhookEventView[]> {
  const rows = await db().query<{ id: string; event_type: string; resource_id: string | null; received_at: Date | string; verified: boolean }>(
    `WITH ids AS (
       SELECT capture_id AS id FROM tabs WHERE room_id = $1 AND capture_id IS NOT NULL
       UNION SELECT authorization_id FROM tabs WHERE room_id = $1 AND authorization_id IS NOT NULL
       UNION SELECT refund_id FROM contests WHERE room_id = $1 AND refund_id IS NOT NULL
       UNION SELECT payout_batch_id FROM payouts WHERE room_id = $1 AND payout_batch_id IS NOT NULL
       UNION SELECT id FROM disputes WHERE room_id = $1
     )
     SELECT w.id, w.event_type, w.resource_id, w.received_at, w.verified FROM webhook_events w
     WHERE w.verified AND (w.resource_id IN (SELECT id FROM ids) OR w.payload->'resource'->>'payout_batch_id' IN (SELECT id FROM ids))
     ORDER BY w.received_at DESC, w.id LIMIT $2`,
    [roomId, limit],
  )
  return rows.map((r) => ({ id: r.id, eventType: r.event_type, resourceId: r.resource_id, receivedAt: new Date(r.received_at).toISOString(), verified: r.verified }))
}
