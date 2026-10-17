// Plain-language copy for server error codes the fan or creator can act on.
export interface ErrorLike {
  code: string
  message: string
  status?: number
  details?: Record<string, unknown>
}

const INTAKE: Record<string, string> = {
  abuse: 'That question breaks the room rules, so it was not posted. Nothing was reserved.',
  injection: 'That reads like instructions to the AI rather than a question, so it was not posted.',
  off_topic: "That doesn't look like a question for this stream, so it was not posted.",
  empty: 'Type a question first.',
  too_long: 'That question is too long. Keep it to a sentence or two.',
}

/** Intake rejections may arrive as the code itself ("off_topic") or inside code/message ("intake_rejected: off_topic"). */
export function intakeMessage(err: ErrorLike): string | null {
  const reason = typeof err.details?.reason === 'string' ? err.details.reason : null
  if (reason && INTAKE[reason]) return INTAKE[reason]
  if (err.code === 'question_rejected') return err.message || 'That question was not posted. Nothing was reserved.'
  const hay = `${err.code} ${err.message}`.toLowerCase()
  for (const [reason, text] of Object.entries(INTAKE)) {
    if (hay.includes(reason) || hay.includes(reason.replace('_', ' ')) || hay.includes(reason.replace('_', '-'))) return text
  }
  return null
}

/** Codes whose server message is already written for the person reading it; never replaced by generic copy. */
const KEEP_SERVER_MESSAGE = new Set(['room_limit', 'still_verifying', 'dispute_open', 'contests_pending', 'tab_exists'])

export function friendlyError(err: ErrorLike): string {
  if (err.code === 'bad_judge_code') return "That judge code wasn't recognized. Check it, or leave the field empty to use the public pool."
  if (err.code === 'room_limit') return err.message || 'This network has opened its daily limit of demo rooms. Try again tomorrow, or use the judge code.'
  if (KEEP_SERVER_MESSAGE.has(err.code) && err.message) return err.message
  if (err.code === 'network_error') return "Can't reach AnswerTab right now. Check the connection and try again."
  if (err.code === 'timeout') return 'That took too long. It may still finish; the screen refreshes when it does.'
  if (err.status === 429 || err.code === 'rate_limited') return 'Too many requests. Wait a few seconds and try again.'
  if (err.status === 401 || err.status === 403) return 'This link is missing its key or the key is wrong.'
  return err.message || 'Something went wrong.'
}
