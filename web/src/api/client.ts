import { currentIdToken } from '../auth/firebase'

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
    res = await fetch(`${BASE}${path}`, { ...init, headers })
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

export interface AllocationView {
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
}

export interface DrinkResponse {
  opId: string
  txnRowKey: string
  allocRowKey: string
  batchId: string
  batchLabel: string
  remainingTotal: number
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
  me: () => request<MeResponse>('/api/me'),
  drink: (key: string) => request<DrinkResponse>('/api/me/drinks', { method: 'POST' }, key),
  undo: (opId: string, key: string) =>
    request<{ remainingTotal: number }>(`/api/me/drinks/${opId}/undo`, { method: 'POST' }, key),
  history: () => request<{ items: HistoryItem[] }>('/api/me/history'),
  balances: () => request<{ balances: BalanceRow[] }>('/api/balances'),
  batches: () => request<{ batches: BatchRow[] }>('/api/batches'),
  claimOptions: () => request<ClaimOptions>('/api/claim/options'),
  claim: (memberId: string, key: string) =>
    request<{ bound: boolean }>('/api/claim', { method: 'POST', body: JSON.stringify({ memberId }) }, key),
  adminUnlink: (memberId: string, key: string) =>
    request<{ unlinked: boolean }>(`/api/admin/members/${memberId}/unlink-email`, { method: 'POST' }, key),
  adminMembers: () => request<{ members: MemberRow[] }>("/api/admin/members"),
  adminLinkEmail: (memberId: string, email: string, key: string) =>
    request<{ linked: boolean }>(
      `/api/admin/members/${memberId}/link-email`,
      { method: "POST", body: JSON.stringify({ email }) },
      key,
    ),
  adminLinkAudit: () => request<{ entries: LinkAuditEntry[] }>("/api/admin/link-audit"),
  redeemQa: (code: string) =>
    request<{ sessionToken: string; qaMemberId: string; expiresAt: string }>('/api/qa/redeem', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
}
