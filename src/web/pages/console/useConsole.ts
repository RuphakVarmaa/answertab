// Creator console state: the ConsoleView snapshot kept live by SSE, plus the transient bits
// (interim speech, detector notes, settle progress) and every creator action.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EvidenceSpan, PayoutView, Rating, ReviewItem, RoomEvent, SegmentSource } from '../../../shared/types.js'
import { useToast } from '../../components/ui.js'
import { api, toApiError, type ConsoleViewPlus, type ReplayResult, type SettleResponse } from '../../lib/api.js'
import { applyConsoleEvent } from '../../lib/events.js'
import { friendlyError } from '../../lib/messages.js'
import { liveReview } from '../../lib/review.js'
import { useLiveState } from '../../lib/useLiveState.js'

export interface VerdictNote {
  id: number
  at: number
  questionNumber: number
  action: 'lock' | 'review' | 'deflected' | 'verifying' | 'ignore'
  quote: string | null
  reason: string
}

const REVIEW_STATUSES = new Set(['ended', 'settling'])

export function useConsole(roomId: string, token: string | null, opts: { onEvent?: (ev: RoomEvent) => void } = {}) {
  const toast = useToast()
  const [serverInterim, setServerInterim] = useState<string | null>(null)
  const [settle, setSettle] = useState<{ done: number; total: number } | null>(null)
  const [notes, setNotes] = useState<VerdictNote[]>([])
  const [review, setReview] = useState<ReviewItem[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  /** Per-tab errors from the last settle run (a PayPal hiccup leaves the room 'settling'). */
  const [settleErrors, setSettleErrors] = useState<SettleResponse['errors']>([])
  const noteSeq = useRef(0)
  const extra = useRef(opts.onEvent)
  extra.current = opts.onEvent
  const statusRef = useRef<string | undefined>(undefined)
  const refetchReview = useRef<() => void>(() => {})
  const reloadRef = useRef<() => Promise<void>>(async () => {})

  const onEvent = useCallback(
    (ev: RoomEvent) => {
      extra.current?.(ev)
      switch (ev.type) {
        case 'segment.interim':
          setServerInterim(ev.text || null)
          break
        case 'segment.added':
          setServerInterim(null)
          break
        case 'question.created':
        case 'question.updated':
          // A verdict can land after End (the verifier was still running): the review list must follow it.
          if (statusRef.current && REVIEW_STATUSES.has(statusRef.current)) refetchReview.current()
          break
        case 'contest.updated':
          // A refund changes the tab's refunded amount and the room totals, which arrive only with a snapshot.
          if (ev.contest.state === 'refunded') void reloadRef.current()
          break
        case 'settle.progress':
          setSettle({ done: ev.done, total: ev.total })
          break
        case 'verdict':
          if (ev.action !== 'ignore')
            setNotes((n) => [{ id: ++noteSeq.current, at: Date.now(), questionNumber: ev.questionNumber, action: ev.action, quote: ev.quote, reason: ev.reason }, ...n].slice(0, 12))
          break
        case 'budget.mode':
          toast(ev.mode === 'manual' ? `Switched to manual confirm: ${ev.reason}` : 'AI checks are back on.', ev.mode === 'manual' ? 'bad' : 'ok')
          break
      }
    },
    [toast],
  )

  const live = useLiveState<ConsoleViewPlus>({
    roomId,
    auth: token ? { creator: token } : null,
    enabled: !!token,
    load: () => api.console(roomId, token!),
    apply: applyConsoleEvent,
    onEvent,
  })
  const view = live.data
  const status = view?.room.status
  statusRef.current = status
  const reload = live.reload
  reloadRef.current = reload

  // The review list after End: fetch it whenever the room is ended and we don't have it (e.g. after reload).
  useEffect(() => {
    if (!token || !status || !REVIEW_STATUSES.has(status) || review) return
    api.review(roomId, token).then(setReview, () => {})
  }, [roomId, token, status, review])
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined
    refetchReview.current = () => {
      clearTimeout(t)
      t = setTimeout(() => {
        if (token) api.review(roomId, token).then(setReview, () => {})
      }, 400)
    }
    return () => clearTimeout(t)
  }, [roomId, token])
  // Snapshot from End / GET review (or the console's own copy), kept current by live question updates.
  const reviewItems = useMemo(() => liveReview(review ?? view?.review ?? null, view?.room.questions ?? []), [review, view?.review, view?.room.questions])

  const act = useCallback(
    async <T>(key: string, fn: () => Promise<T>, opts: { ok?: string; reload?: boolean; quiet?: boolean } = {}): Promise<T | undefined> => {
      setBusy(key)
      try {
        const r = await fn()
        if (opts.ok) toast(opts.ok, 'ok')
        if (opts.reload) void reload()
        return r
      } catch (e) {
        if (!opts.quiet) toast(friendlyError(toApiError(e)), 'bad')
        else throw e
        return undefined
      } finally {
        setBusy(null)
      }
    },
    [reload, toast],
  )

  const t = token ?? ''
  const actions = useMemo(
    () => ({
      start: () => act('start', () => api.start(roomId, t), { reload: true }),
      end: async () => {
        const items = await act('end', () => api.end(roomId, t), { reload: true })
        if (items) setReview(items)
      },
      settle: async (ratings: Record<number, Rating>) => {
        setSettle({ done: 0, total: 0 })
        setSettleErrors([])
        const r = await act('settle', () => api.settle(roomId, t, ratings), { reload: true })
        setSettle(null)
        if (!r) {
          refetchReview.current()
          return
        }
        setSettleErrors(r.errors)
        const st = r.room?.status
        if (st === 'settled') toast(r.errors.length ? 'Settled with PayPal. Some tabs reported errors; see below.' : 'Settled with PayPal.', 'ok')
        else if (st === 'voided') toast('Every hold voided. Nobody was charged.', 'ok')
        else if (r.errors.length) toast(`PayPal did not finish ${r.errors.length === 1 ? 'one tab' : `${r.errors.length} tabs`}. Retry settlement; nothing is charged twice.`, 'bad')
      },
      hide: (qid: string) => act(`hide:${qid}`, () => api.hide(qid, t), { reload: true }),
      undo: (qid: string) => act(`undo:${qid}`, () => api.undo(qid, t), { reload: true, ok: 'Lock undone. Nothing was charged.' }),
      point: (qid: string, span: EvidenceSpan) => act(`point:${qid}`, () => api.point(qid, t, span), { reload: true, quiet: true }),
      segment: (text: string, final: boolean, source: SegmentSource, lagMs?: number) =>
        api.segment(roomId, t, { text, final, source, ...(lagMs !== undefined ? { lagMs } : {}) }),
      replay: (callId: string): Promise<ReplayResult | undefined> => act(`replay:${callId}`, () => api.replay(callId, t), { quiet: true }),
      closeWindow: async () => {
        const r = await act('close', () => api.closeContestWindow(roomId, t), { reload: true })
        if (r === undefined) return
        const payout = r && typeof r === 'object' && 'payout' in r ? (r as { payout: PayoutView | null }).payout : null
        toast(payout ? 'Contest window closed. Payout sent to PayPal.' : 'Contest window closed. No payout was created.', payout ? 'ok' : 'info')
      },
      setLanguage: (language: string) => act('language', () => api.roomSettings(roomId, t, { language }), { reload: true, ok: `Speech language set to ${language}.` }),
      decide: (contestId: string, approve: boolean) =>
        act(`decide:${contestId}`, () => api.decideContest(contestId, t, approve), { reload: true, ok: approve ? 'Refund approved.' : 'Charge kept.' }),
    }),
    [act, roomId, t],
  )

  return { roomId, token, live, view, serverInterim, settle, notes, review: reviewItems, setReview, busy, actions, settleErrors }
}

export type ConsoleModel = ReturnType<typeof useConsole>
