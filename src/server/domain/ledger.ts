// The PayPal ledger panel: every recorded call is pushed to that room's creator stream; captures can be replayed.
import { getLedgerCall, isPayPalError, onLedgerCall, replayCapture } from '../paypal/index.js'
import { CREATOR, emit } from './bus.js'
import { conflict, notFound } from './errors.js'

let unsubscribe: (() => void) | null = null

export function initLedgerFeed(): void {
  if (unsubscribe) return
  unsubscribe = onLedgerCall(({ roomId, call }) => {
    if (roomId) emit(roomId, { type: 'ledger.call', call }, CREATOR)
  })
}

export async function ledgerCallRoom(callId: string): Promise<string> {
  const row = await getLedgerCall(callId).catch(() => null)
  if (!row || !row.room_id) throw notFound('call_not_found', 'No such ledger call in a room.')
  return row.room_id
}

/** "Replay to PayPal": resend a stored capture with its original PayPal-Request-Id; PayPal returns the same capture. */
export async function replayLedgerCall(callId: string): Promise<{ captureId: string; sameAsOriginal: boolean; originalCaptureId: string; httpStatus: number }> {
  try {
    return await replayCapture(callId)
  } catch (e) {
    if (isPayPalError(e) && e.name === 'LEDGER_CALL_NOT_FOUND') throw notFound('call_not_found', 'No such ledger call.')
    if (isPayPalError(e) && e.name === 'NOT_REPLAYABLE') throw conflict('not_replayable', 'Only a successful capture can be replayed.')
    throw e
  }
}
