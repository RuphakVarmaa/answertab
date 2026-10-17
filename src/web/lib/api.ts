// Typed client for the AnswerTab HTTP API (ARCHITECTURE.md "HTTP API"). Errors always surface as ApiError
// with the server's { error: { code, message } } when it sent one.
import type {
  ConsoleView,
  ContestView,
  EvidenceSpan,
  FanSelfView,
  Funding,
  PayoutView,
  PublicConfig,
  QuestionView,
  Rating,
  ReceiptView,
  ReviewItem,
  RoomKind,
  RoomView,
  SegmentSource,
  StatusCheck,
  TabView,
} from '../../shared/types.js'

export class ApiError extends Error {
  readonly code: string
  readonly status: number
  /** Extra fields the server put next to code/message (e.g. { reason } or { similarTo, similarText }). */
  readonly details: Record<string, unknown>
  constructor(code: string, message: string, status: number, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.details = details
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError
}

export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e
  if (e instanceof Error) return new ApiError('client_error', e.message, 0)
  return new ApiError('client_error', String(e), 0)
}

export type Auth = { creator: string } | { fan: string } | null

interface RequestOpts {
  body?: unknown
  auth?: Auth
  timeoutMs?: number
  signal?: AbortSignal
}

async function request<T>(method: 'GET' | 'POST', path: string, opts: RequestOpts = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  if (opts.auth && 'creator' in opts.auth) headers['x-creator-token'] = opts.auth.creator
  if (opts.auth && 'fan' in opts.auth) headers['x-fan-token'] = opts.auth.fan

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), opts.timeoutMs ?? 20_000)
  const onOuterAbort = () => ctrl.abort(opts.signal?.reason)
  opts.signal?.addEventListener('abort', onOuterAbort, { once: true })

  let res: Response
  try {
    res = await fetch(path, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: ctrl.signal,
      credentials: 'same-origin',
    })
  } catch (e) {
    const timedOut = ctrl.signal.reason instanceof DOMException && ctrl.signal.reason.name === 'TimeoutError'
    if (timedOut) throw new ApiError('timeout', 'The request timed out.', 0)
    if (opts.signal?.aborted) throw new ApiError('aborted', 'Request cancelled.', 0)
    throw new ApiError('network_error', e instanceof Error ? e.message : 'Network error', 0)
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onOuterAbort)
  }

  const text = await res.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: unknown; message?: unknown } & Record<string, unknown> } | null)?.error
    const code = typeof err?.code === 'string' ? err.code : `http_${res.status}`
    const message = typeof err?.message === 'string' ? err.message : res.statusText || `HTTP ${res.status}`
    const { code: _c, message: _m, ...details } = err ?? {}
    throw new ApiError(code, message, res.status, details)
  }
  return data as T
}

const get = <T>(path: string, opts?: RequestOpts) => request<T>('GET', path, opts)
const post = <T>(path: string, body?: unknown, opts?: RequestOpts) => request<T>('POST', path, { ...opts, body: body ?? {} })
const enc = encodeURIComponent

/** Accept either a bare array or { [key]: array } so small server shape choices don't break the page. */
function list<T>(data: unknown, ...keys: string[]): T[] {
  if (Array.isArray(data)) return data as T[]
  if (data && typeof data === 'object') {
    for (const k of keys) {
      const v = (data as Record<string, unknown>)[k]
      if (Array.isArray(v)) return v as T[]
    }
  }
  return []
}

export interface DemoRoom {
  roomId: string
  creatorToken: string
  stripFans: { fanId: string; fanToken: string; displayName: string }[]
  /** Which LLM budget pool the room landed in (judge code accepted or not). */
  pool?: 'judge' | 'public'
}

export interface ReplayResult {
  captureId: string
  sameAsOriginal: boolean
  originalCaptureId?: string
  httpStatus?: number
}

export interface VerifyRecord {
  kind: string
  id: string
  status: string
  amountCents?: number
}

export interface VerifyResult {
  verifiedAt: string
  records: VerifyRecord[]
  receipt: ReceiptView | null
  /** The server's own comparison of PayPal's record against the receipt. null when it did not send one. */
  matches: boolean | null
  mismatches: string[]
}

const asRecord = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {})
const str = (x: unknown): string | null => (typeof x === 'string' && x ? x : null)

/** POST verify may answer with { records }, a fresh ReceiptView, or PayPal objects; reduce all to records. */
export function normalizeVerify(data: unknown): VerifyResult {
  const obj = asRecord(data)
  const records: VerifyRecord[] = []
  for (const r of list<Record<string, unknown>>(obj, 'records', 'checks', 'items')) {
    const id = str(r.id) ?? str(r.resourceId)
    const status = str(r.status) ?? str(r.resourceStatus)
    if (id && status) records.push({ kind: str(r.kind) ?? str(r.type) ?? 'record', id, status, ...(typeof r.amountCents === 'number' ? { amountCents: r.amountCents } : {}) })
  }
  for (const kind of ['authorization', 'capture', 'void', 'refund', 'order'] as const) {
    const r = asRecord(obj[kind])
    const id = str(r.id)
    const status = str(r.status)
    const amount = typeof r.amountCents === 'number' ? r.amountCents : typeof r.grossCents === 'number' ? r.grossCents : undefined
    if (id && status && !records.some((x) => x.id === id)) records.push({ kind, id, status, ...(amount !== undefined ? { amountCents: amount } : {}) })
  }
  const receipt = Array.isArray(obj.lines) && obj.tab ? (obj as unknown as ReceiptView) : obj.receipt && typeof obj.receipt === 'object' ? (obj.receipt as ReceiptView) : null
  if (receipt && records.length === 0) {
    const t = receipt.tab
    if (t.authorizationId && t.authStatus) records.push({ kind: 'authorization', id: t.authorizationId, status: t.authStatus })
    if (t.captureId) records.push({ kind: 'capture', id: t.captureId, status: t.state === 'captured' ? 'COMPLETED' : t.state.toUpperCase() })
  }
  const mismatches = Array.isArray(obj.mismatches) ? obj.mismatches.filter((m): m is string => typeof m === 'string' && m.length > 0) : []
  const matches = typeof obj.matches === 'boolean' ? obj.matches && mismatches.length === 0 : mismatches.length > 0 ? false : null
  return { verifiedAt: str(obj.checkedAt) ?? str(obj.verifiedAt) ?? receipt?.verifiedAt ?? new Date().toISOString(), records, receipt, matches, mismatches }
}

/** CUSTOMER.DISPUTE.* as the console stores it (GET /console `disputes`). */
export interface DisputeView {
  id: string
  tabId: string | null
  status: string | null
  reason: string | null
  amountCents: number | null
  evidencePack: unknown
  updatedAt: string | null
}

/** Room money totals the server computes (refunds included). Absent on older servers. */
export interface ConsoleTotals {
  grossCents: number
  feeCents: number
  refundedCents: number
  netCents: number
}

/** GET /console: ConsoleView plus the extras the API layer adds (all optional so older servers still load). */
export type ConsoleViewPlus = ConsoleView & {
  review?: ReviewItem[]
  disputes?: DisputeView[]
  totals?: ConsoleTotals | null
}

export interface SettleResponse {
  room: RoomView | null
  tabs: (TabView & { displayName?: string; isBot?: boolean })[]
  errors: { tabId: string | null; message: string }[]
}

export function normalizeSettle(data: unknown): SettleResponse {
  const obj = asRecord(data)
  const room = obj.room && typeof obj.room === 'object' && typeof (obj.room as RoomView).status === 'string' ? (obj.room as RoomView) : null
  const tabs = Array.isArray(obj.tabs) ? (obj.tabs as SettleResponse['tabs']) : []
  const errors = (Array.isArray(obj.errors) ? obj.errors : []).flatMap((e) => {
    const r = asRecord(e)
    const message = str(r.message)
    return message ? [{ tabId: str(r.tabId), message }] : []
  })
  return { room, tabs, errors }
}

/** The last synthetic run that passed, from GET /api/status `lastPassedRun` (IDs and statuses only). */
export interface RecordedRun {
  finishedAt: string | null
  roomId: string | null
  steps: { name: string; paypalId: string; status: string | null }[]
}

/** Accepts the server's `{ steps: [{ name, paypalId, status }] }`, or a raw synthetic `details.paypal`. */
export function normalizeRecordedRun(data: unknown): RecordedRun | null {
  if (!data || typeof data !== 'object') return null
  const r = asRecord(data)
  const steps: RecordedRun['steps'] = []
  for (const x of Array.isArray(r.steps) ? r.steps : []) {
    const st = asRecord(x)
    const paypalId = str(st.paypalId) ?? str(st.id)
    if (paypalId) steps.push({ name: str(st.name) ?? 'PayPal call', paypalId, status: str(st.status) })
  }
  if (steps.length === 0) {
    const pp = asRecord(r.paypal ?? asRecord(r.details).paypal)
    for (const t of Array.isArray(pp.tabs) ? pp.tabs : []) {
      const x = asRecord(t)
      const fan = str(x.fan) ?? 'fan'
      if (str(x.authorizationId)) steps.push({ name: `${fan}: hold`, paypalId: str(x.authorizationId)!, status: str(x.authStatus) })
      if (str(x.captureId)) steps.push({ name: `${fan}: capture`, paypalId: str(x.captureId)!, status: str(x.state) })
    }
    const rf = asRecord(pp.refund)
    if (str(rf.refundId)) steps.push({ name: 'contest refund', paypalId: str(rf.refundId)!, status: str(rf.state) })
    const po = asRecord(pp.payout)
    if (str(po.payoutBatchId)) steps.push({ name: 'creator payout', paypalId: str(po.payoutBatchId)!, status: str(po.batchStatus) ?? str(po.state) })
  }
  if (steps.length === 0) return null
  return { finishedAt: str(r.finishedAt) ?? str(r.finished_at), roomId: str(r.roomId), steps }
}

export interface StatusReport {
  checks: StatusCheck[]
  lastPassedRun: RecordedRun | null
}

export const api = {
  config: () => get<PublicConfig>('/api/config'),
  status: async () => list<StatusCheck>(await get<unknown>('/api/status'), 'checks', 'items'),
  statusReport: async (): Promise<StatusReport> => {
    const data = await get<unknown>('/api/status')
    return { checks: list<StatusCheck>(data, 'checks', 'items'), lastPassedRun: normalizeRecordedRun(asRecord(data).lastPassedRun) }
  },

  createDemo: (judgeCode?: string) => post<DemoRoom>('/api/demo', judgeCode ? { judgeCode } : {}, { timeoutMs: 30_000 }),
  createRoom: (p: { title?: string; kind: RoomKind; language?: string }) => post<{ roomId: string; creatorToken: string }>('/api/rooms', p),
  roomSettings: (id: string, creator: string, p: { language: string }) => post<unknown>(`/api/rooms/${enc(id)}/settings`, p, { auth: { creator } }),

  room: (id: string) => get<RoomView>(`/api/rooms/${enc(id)}`),
  console: (id: string, creator: string) => get<ConsoleViewPlus>(`/api/rooms/${enc(id)}/console`, { auth: { creator } }),
  start: (id: string, creator: string) => post<unknown>(`/api/rooms/${enc(id)}/start`, {}, { auth: { creator } }),
  segment: (id: string, creator: string, p: { text: string; final: boolean; source: SegmentSource; lagMs?: number }) =>
    post<unknown>(`/api/rooms/${enc(id)}/segments`, p, { auth: { creator } }),

  join: (id: string, displayName: string) => post<{ fanId: string; fanToken: string }>(`/api/rooms/${enc(id)}/fans`, { displayName }),
  tabOrder: (id: string, fan: string, p: { ceilingCents: number; funding: Extract<Funding, 'card' | 'paypal'> }) =>
    post<{ orderId: string }>(`/api/rooms/${enc(id)}/tab/order`, p, { auth: { fan }, timeoutMs: 30_000 }),
  tabAuthorize: (id: string, fan: string, orderId: string) =>
    post<TabView>(`/api/rooms/${enc(id)}/tab/authorize`, { orderId }, { auth: { fan }, timeoutMs: 45_000 }),
  me: (id: string, fan: string) => get<FanSelfView>(`/api/rooms/${enc(id)}/me`, { auth: { fan } }),

  /** checkSimilar: the server answers 409 similar_question { similarTo, similarText } and reserves nothing. */
  ask: (id: string, fan: string, text: string, checkSimilar = false) =>
    post<QuestionView>(`/api/rooms/${enc(id)}/questions`, { text, checkSimilar }, { auth: { fan }, timeoutMs: 30_000 }),
  back: (qid: string, fan: string) => post<unknown>(`/api/questions/${enc(qid)}/back`, {}, { auth: { fan } }),

  hide: (qid: string, creator: string) => post<unknown>(`/api/questions/${enc(qid)}/hide`, {}, { auth: { creator } }),
  undo: (qid: string, creator: string) => post<unknown>(`/api/questions/${enc(qid)}/undo`, {}, { auth: { creator } }),
  point: (qid: string, creator: string, span: EvidenceSpan) =>
    post<unknown>(`/api/questions/${enc(qid)}/point`, { span }, { auth: { creator }, timeoutMs: 30_000 }),

  end: async (id: string, creator: string) => list<ReviewItem>(await post<unknown>(`/api/rooms/${enc(id)}/end`, {}, { auth: { creator } }), 'items', 'review'),
  review: async (id: string, creator: string) => list<ReviewItem>(await get<unknown>(`/api/rooms/${enc(id)}/review`, { auth: { creator } }), 'items', 'review'),
  settle: async (id: string, creator: string, ratings: Record<number, Rating>) =>
    normalizeSettle(await post<unknown>(`/api/rooms/${enc(id)}/settle`, { ratings }, { auth: { creator }, timeoutMs: 180_000 })),
  replay: (callId: string, creator: string) => post<ReplayResult>(`/api/ledger/${enc(callId)}/replay`, {}, { auth: { creator }, timeoutMs: 30_000 }),
  closeContestWindow: (id: string, creator: string) =>
    post<PayoutView | unknown>(`/api/rooms/${enc(id)}/close-contest-window`, {}, { auth: { creator }, timeoutMs: 45_000 }),
  decideContest: (contestId: string, creator: string, approve: boolean) =>
    post<ContestView>(`/api/contests/${enc(contestId)}/decide`, { approve }, { auth: { creator }, timeoutMs: 45_000 }),

  receipt: (token: string) => get<ReceiptView>(`/api/receipts/${enc(token)}`),
  verifyReceipt: async (token: string) => normalizeVerify(await post<unknown>(`/api/receipts/${enc(token)}/verify`, {}, { timeoutMs: 30_000 })),
  contest: (token: string, backingId: string, reason: string) => post<ContestView>(`/api/receipts/${enc(token)}/contest`, { backingId, reason }),

  qrUrl: (id: string) => `/api/rooms/${enc(id)}/qr`,
  /** SSE URL. The server reads only `token` (and redacts it from logs); no aliases. */
  eventsUrl: (id: string, auth: Auth) => {
    const q = new URLSearchParams()
    if (auth && 'creator' in auth) {
      q.set('token', auth.creator)
      q.set('role', 'creator')
    } else if (auth && 'fan' in auth) {
      q.set('token', auth.fan)
      q.set('role', 'fan')
    }
    return `/api/rooms/${enc(id)}/events?${q.toString()}`
  },
}
