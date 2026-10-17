// Domain API for the routes, jobs and demo director. Routes call only these.
export { DomainError, toHttpError, unauthorized as unauthorizedError } from './errors.js'
export { onRoomEvent, emit, ALL, CREATOR, OTHERS, toFan, type Audience, type BusListener } from './bus.js'
export { now, nowDate, setNowForTests, roomClockMs, WINDOWS } from './clock.js'
export { requireCreator, requireFan, findFan, creatorTokenMatches, judgeCodeMatches, looksLikeToken } from './auth.js'
export { requireRoom } from './views.js'
export {
  createRoom, startRoom, endRoom, autoEndRoom, updateRoomSettings, getReview, publicRoomView, getConsoleView, roomQrPng, roomLinks, roomTotals,
  DEFAULT_PRICES, ROOMS_PER_IP_PER_DAY, roomsPerIpPerDay, ROOM_LANGUAGES, isRoomLanguage, cleanText, type ConsoleViewPlus, type RoomTotals, type ReviewItemPlus,
} from './rooms.js'
export { joinRoom, getMe, openTabOrder, authorizeTab, openBotTab, applyAuthorization } from './tabs.js'
export { askQuestion, backQuestion, hideQuestion, undoQuestion, pointSpan, roomOfQuestion, getQuestion } from './questions.js'
export { addSegment, stampSegment, clampLag, type SegmentInput } from './segments.js'
export {
  initDetection, startDetector, stopDetector, stopAllDetectors, resumeLiveRooms, detectionIdle, triggerDetection,
  setRoomMode, applyVerdict, openSet, isDetecting,
} from './detection.js'
export {
  settleRoom, settleTab, finishRoom, autoVoidRoom, retrySettle, resumeSettlingRooms, noteToPayer, receiptUrl, COMPLETED_CAPTURE,
  type SettleResult, type RatingsInput,
} from './settle.js'
export { getReceipt, verifyReceipt, tabByReceipt, VERIFY_EVERY_MS, type VerifyResult, type ReceiptViewPlus, type ReceiptLinePlus, type ReceiptLineStatus } from './receipts.js'
export { createContest, decideContest, contestDeps, contestsIdle, contestRoomId, issueRefund, getContest, recoverStaleContests, DESK_STALE_MS } from './contests.js'
export { closeContestWindow, pollPayout, getPayoutView, payoutWebhook } from './payouts.js'
export { listDisputes, syncDispute, evidencePack, hasOpenDispute, type DisputeView } from './disputes.js'
export { receiveWebhook, webhooksIdle, reconcile } from './webhooks.js'
export { expireRoom } from './lifecycle.js'
export { scheduleJob, cancelJob, type JobKind, type JobRow, type JobResult } from './jobQueue.js'
export { initLedgerFeed, ledgerCallRoom, replayLedgerCall } from './ledger.js'
export { initDomain } from './init.js'
export { publicConfig } from './publicConfig.js'
