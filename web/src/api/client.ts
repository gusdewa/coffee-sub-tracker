import { currentIdToken } from '../auth/firebase'
import { withMutationGuard } from '../pwa/mutationGuard'

/**
 * The API client.
 *
 * Every mutating call carries an `Idempotency-Key` generated once per user
 * intent — so a double tap, a flaky network, or a retry can never turn one
 * press into two drinks. The key is created by the caller, not here, because
 * a retry must reuse the *same* key.
 */

const BASE = import.meta.env.VITE_API_BASE_URL ?? ''

/**
 * A redeemed QA session, held in memory only.
 *
 * Never written to localStorage, sessionStorage, IndexedDB or a cookie: a
 * reload should end the QA session rather than leave a bearer token lying
 * around in a browser profile. It is an opaque server-issued token, so it
 * works whether or not Firebase sign-in is configured.
 */
let qaSessionToken: string | null = null

export function setQaSession(token: string | null): void {
  qaSessionToken = token
}

export function hasQaSession(): boolean {
  return qaSessionToken !== null
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export class OfflineError extends Error {
  readonly code = 'OFFLINE'
  constructor() {
    super('No connection')
    this.name = 'OfflineError'
  }
}

/**
 * A read that outlived its deadline. Distinct from OfflineError so the UI can
 * say "took too long" rather than "no connection" when the network is up but
 * the answer never came.
 */
export class TimeoutError extends Error {
  readonly code = 'TIMEOUT'
  constructor() {
    super('Request timed out')
    this.name = 'TimeoutError'
  }
}

/**
 * A Drink whose answer was lost while the device still believed it was online.
 * The request may have been committed before the connection dropped, so unlike
 * OfflineError this must never claim the cup was not counted.
 */
export class UnconfirmedDrinkError extends Error {
  readonly code = 'DRINK_UNCONFIRMED'
  constructor() {
    super('Drink not confirmed')
    this.name = 'UnconfirmedDrinkError'
  }
}

export interface ReadOptions {
  /** Fail with TimeoutError after this long, token refresh included. */
  timeoutMs?: number
  /** Abandon the read; it then rejects with a DOMException named AbortError. */
  signal?: AbortSignal
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  idempotencyKey?: string,
): Promise<T> {
  // A QA session takes precedence: it is the only credential that exists when
  // the tester has not signed in with Google at all.
  const authorization = qaSessionToken
    ? `QA ${qaSessionToken}`
    : await currentIdToken().then((t) => (t ? `Bearer ${t}` : ''))

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(authorization ? { Authorization: authorization } : {}),
    ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
  }

  let res: Response
  try {
    // Balance refreshes must reach the API: a browser HTTP-cache hit would keep
    // an externally granted subscription invisible even after resume/reconnect.
    res = await fetch(`${BASE}${path}`, { cache: 'no-store', ...init, headers })
  } catch {
    throw new OfflineError()
  }

  if (res.status === 204) return undefined as T

  const body = (await res.json().catch(() => ({}))) as {
    error?: { code: string; message: string }
  }

  if (!res.ok) {
    const err = body.error
    throw new ApiError(err?.code ?? 'UNKNOWN', err?.message ?? 'Request failed', res.status)
  }
  return body as T
}

/** What fetch itself throws on abort, so callers can ignore their own cancellations. */
const readAborted = () => new DOMException('The read was aborted.', 'AbortError')

/**
 * A GET with an optional deadline and an optional caller signal.
 *
 * Reads only. Drink, Undo, claim and the admin mutations stay on request() with
 * no signal and no timer: aborting one client-side could orphan a commit the
 * server already made, and the person would then tap again.
 *
 * The deadline races the whole of request(), not just fetch: currentIdToken()
 * can hang on a Firebase refresh before fetch ever sees a signal. Aborting the
 * controller also releases the socket rather than leaving it to answer into
 * nothing.
 */
function read<T>(path: string, { timeoutMs, signal }: ReadOptions = {}): Promise<T> {
  const deadline =
    typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) ? timeoutMs : undefined
  // No options is exactly the old call, returned as is: no controller, no
  // timer, and no extra async hop, so every existing caller settles on the
  // same tick as before.
  if (deadline === undefined && !signal) return request<T>(path)
  return boundedRead<T>(path, deadline, signal)
}

async function boundedRead<T>(
  path: string,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal?.aborted) throw readAborted()

  const controller = new AbortController()
  // Set by whichever stop comes first; it names the failure. The OfflineError
  // that fetch raises for our own abort is a consequence, not the cause.
  let stoppedBy: Error | null = null
  let rejectEarly!: (error: Error) => void
  const stoppedEarly = new Promise<never>((_resolve, reject) => {
    rejectEarly = reject
  })
  const stop = (error: Error) => {
    if (stoppedBy) return
    stoppedBy = error
    // Reject before aborting, so the race settles on the cause, not on fetch's reaction to it.
    rejectEarly(error)
    controller.abort()
  }
  const onCallerAbort = () => stop(readAborted())

  const timer =
    timeoutMs === undefined ? undefined : setTimeout(() => stop(new TimeoutError()), timeoutMs)
  signal?.addEventListener('abort', onCallerAbort, { once: true })
  try {
    return await Promise.race([request<T>(path, { signal: controller.signal }), stoppedEarly])
  } catch (error) {
    throw stoppedBy ?? error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onCallerAbort)
  }
}

export interface AllocationView {
  allocRowKey: string
  batchId: string
  batchLabel: string
  granted: number
  consumed: number
  remaining: number
  effectiveAt: string
}

export interface MeResponse {
  member: { memberId: string; displayName: string; role: 'member' | 'admin'; isQa: boolean }
  totalRemaining: number
  allocations: AllocationView[]
  /** Optional only while an older API may still be serving a rolling deploy. */
  undoOffer?: UndoOfferResponse | null
}

export interface UndoOfferResponse {
  opId: string
  allocRowKey: string
  batchId: string
  batchLabel: string
  createdAt: string
  undoExpiresAt: string
}

export interface DrinkResponse {
  opId: string
  txnRowKey: string
  allocRowKey: string
  batchId: string
  batchLabel: string
  remainingTotal: number
  createdAt: string
  undoExpiresAt: string
  replayed: boolean
}

export interface HistoryItem {
  opId: string
  type: string
  delta: number
  batchLabel: string
  reason?: string
  createdAt: string
  reversed: boolean
}

export interface BalanceRow {
  memberId: string
  displayName: string
  remaining: number
}

export interface MemberRow {
  memberId: string
  displayName: string
  email: string
  role: "member" | "admin"
  status: "active" | "disabled"
  pending: boolean
}

export interface LinkAuditEntry {
  actorMemberId: string
  memberId: string
  email: string
  createdAt: string
}

export interface ClaimCandidate {
  memberId: string
  displayName: string
}

export interface ClaimOptions {
  bound: boolean
  candidates?: ClaimCandidate[]
  prediction?: { memberId?: string; confidence: number }
}

export interface BatchRow {
  batchId: string
  label: string
  effectiveAt: string
  totalUnits: number
  status: string
}

export const api = {
  me: () => read<MeResponse>('/api/me'),
  drink: (key: string) =>
    withMutationGuard(() => request<DrinkResponse>('/api/me/drinks', { method: 'POST' }, key)),
  undo: (opId: string, key: string) =>
    withMutationGuard(() =>
      request<{ remainingTotal: number }>(`/api/me/drinks/${opId}/undo`, { method: 'POST' }, key),
    ),
  /** Without a limit the API's default page (50) applies, as it always has. */
  history: (limit?: number, opts?: ReadOptions) =>
    read<{ items: HistoryItem[] }>(`/api/me/history${limit ? `?limit=${limit}` : ''}`, opts),
  balances: (opts?: ReadOptions) => read<{ balances: BalanceRow[] }>('/api/balances', opts),
  batches: () => read<{ batches: BatchRow[] }>('/api/batches'),
  claimOptions: () => read<ClaimOptions>('/api/claim/options'),
  claim: (memberId: string, key: string) =>
    withMutationGuard(() =>
      request<{ bound: boolean }>('/api/claim', { method: 'POST', body: JSON.stringify({ memberId }) }, key),
    ),
  adminUnlink: (memberId: string, key: string) =>
    withMutationGuard(() =>
      request<{ unlinked: boolean }>(`/api/admin/members/${memberId}/unlink-email`, { method: 'POST' }, key),
    ),
  adminMembers: () => read<{ members: MemberRow[] }>("/api/admin/members"),
  adminLinkEmail: (memberId: string, email: string, key: string) =>
    withMutationGuard(() =>
      request<{ linked: boolean }>(
        `/api/admin/members/${memberId}/link-email`,
        { method: "POST", body: JSON.stringify({ email }) },
        key,
      ),
    ),
  adminLinkAudit: () => read<{ entries: LinkAuditEntry[] }>("/api/admin/link-audit"),
  redeemQa: (code: string) =>
    request<{ sessionToken: string; qaMemberId: string; expiresAt: string }>('/api/qa/redeem', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
}
