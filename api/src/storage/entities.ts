/**
 * Entity shapes for the four Azure Tables.
 *
 * Azure Table Storage is schemaless, so these interfaces are the only place
 * the intended shape is written down. Every property here is a supported EDM
 * type (string, int32, boolean, datetime) — no nested objects.
 */

export const TABLES = {
  members: 'CoffeeMembers',
  ledger: 'CoffeeLedger',
  batches: 'CoffeeBatches',
  qaSessions: 'CoffeeQaSessions',
} as const

export type TableName = (typeof TABLES)[keyof typeof TABLES]

/** Common fields the service adds to every entity. */
export interface EntityBase {
  partitionKey: string
  rowKey: string
  etag?: string
  timestamp?: string
}

// --- CoffeeLedger -----------------------------------------------------------

export type TransactionType = 'CONSUME' | 'REVERSAL' | 'CORRECTION' | 'GRANT'

/** `A|<effectiveAt>|<batchId>` — one member's units from one batch. */
export interface AllocationEntity extends EntityBase {
  kind: 'allocation'
  batchId: string
  batchLabel: string
  granted: number
  consumed: number
  /** Kept explicit (rather than derived) so a query can filter on it. */
  remaining: number
  effectiveAt: Date
}

/** `T|<invTicks>|<opId>` — an audit row. Never updated, never deleted. */
export interface TransactionEntity extends EntityBase {
  kind: 'transaction'
  type: TransactionType
  delta: number
  allocRowKey: string
  batchId: string
  opId: string
  /** Who performed it — differs from the subject only for admin corrections. */
  actorMemberId: string
  subjectMemberId: string
  reason?: string
  reversesOpId?: string
  createdAt: Date
}

/** `R|<originalOpId>` — inserting this is what makes a second Undo impossible. */
export interface ReversalSentinelEntity extends EntityBase {
  kind: 'reversal-sentinel'
  reversalOpId: string
  createdAt: Date
}

/** `U|LATEST_CONSUME` — serializes the latest-only Put Back invariant. */
export interface LatestConsumeMarkerEntity extends EntityBase {
  kind: 'latest-consume-marker'
  /** Never cleared, so reversing the latest Drink cannot expose an older one. */
  latestOpId: string
  /** Empty after the latest Drink has been reversed. */
  activeOpId: string
  updatedAt: Date
}

/** `I|<opId>` — inserting this is what makes a duplicate tap impossible. */
export interface IdempotencyEntity extends EntityBase {
  kind: 'idempotency'
  txnRowKey: string
  statusCode: number
  /** The response body to replay verbatim on a duplicate delivery. */
  resultJson: string
  createdAt: Date
}

// --- CoffeeMembers ----------------------------------------------------------

export type MemberRole = 'member' | 'admin'
export type MemberStatus = 'active' | 'disabled'

/** `M|<memberId>` in the ROSTER partition — the allowlist and the authority. */
export interface MemberEntity extends EntityBase {
  kind: 'member'
  memberId: string
  /** Empty for synthetic QA members, which have no address by design. */
  email: string
  displayName: string
  role: MemberRole
  status: MemberStatus
  firebaseUid: string
  isSynthetic: boolean
  createdAt: Date
}

/** `E|<sha256(email)>` in the ROSTER partition — hashed, so it carries no PII. */
export interface EmailIndexEntity extends EntityBase {
  kind: 'email-index'
  memberId: string
}

// --- CoffeeBatches ----------------------------------------------------------

export type BatchStatus = 'provisioning' | 'active'

export interface BatchEntity extends EntityBase {
  kind: 'batch'
  batchId: string
  label: string
  purchasedAt: Date
  effectiveAt: Date
  totalUnits: number
  status: BatchStatus
  createdByMemberId: string
  /** JSON array — Table Storage has no list type. */
  provisionedMemberIds: string
}

// --- CoffeeQaSessions -------------------------------------------------------

export interface QaSessionEntity extends EntityBase {
  kind: 'qa-session'
  linkId: string
  qaMemberId: string
  expiresAt: Date
  maxUses: number
  usedCount: number
  revokedAt?: Date
  createdByMemberId: string
  createdAt: Date
}
