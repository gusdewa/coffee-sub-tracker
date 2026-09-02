import { randomBytes, timingSafeEqual } from 'node:crypto'
import { odata, type TableClient } from '@azure/data-tables'
import { ulid } from 'ulid'
import type { KeyLike } from 'jose'

import { QA_PARTITION, qaSessionRowKey } from '../storage/keys.js'
import { isNotFound, isPreconditionFailed } from '../storage/tableClient.js'
import { upsertMember, setMemberStatus, type RosterDeps } from '../storage/roster.js'
import { mintCustomToken, type ServiceAccount } from '../auth/customToken.js'

/**
 * Short-lived, revocable, single-use QA links.
 *
 * The plaintext code exists in exactly two places and never at rest: in the
 * creation response, and in the body of the redemption request. Only its
 * SHA-256 is stored, as the RowKey.
 *
 * Every QA link gets its **own synthetic member**, so QA drinks land in their
 * own ledger partition and can never touch a real balance. Revoking flips that
 * member to disabled, which the per-request roster check honours immediately —
 * so revocation beats an unexpired token rather than waiting it out.
 */

const CODE_BYTES = 32 // 256 bits
const DEFAULT_TTL_MINUTES = 120
const DEFAULT_MAX_USES = 1
const MAX_FAILED_ATTEMPTS = 10

export class QaLinkInvalidError extends Error {
  readonly code = 'QA_LINK_INVALID'
  constructor() {
    // One message for every failure mode: absent, expired, spent, revoked.
    // Distinguishing them would let a caller probe which codes exist.
    super('That QA link is not valid')
    this.name = 'QaLinkInvalidError'
  }
}

export interface QaDeps extends RosterDeps {
  qaSessions: TableClient
  serviceAccount?: ServiceAccount | undefined
  /** Injectable for tests that sign with a locally generated key. */
  signingKey?: KeyLike
  now?: () => Date
}

export interface CreateQaLinkInput {
  ttlMinutes?: number
  maxUses?: number
  label?: string
}

export interface CreatedQaLink {
  linkId: string
  /** Returned exactly once. Never stored, never logged. */
  code: string
  qaMemberId: string
  expiresAt: Date
  maxUses: number
}

export async function createQaLink(
  deps: QaDeps,
  actorMemberId: string,
  input: CreateQaLinkInput = {},
): Promise<CreatedQaLink> {
  const now = deps.now?.() ?? new Date()
  const code = randomBytes(CODE_BYTES).toString('base64url')
  const linkId = ulid()
  const qaMemberId = ulid()
  const ttl = input.ttlMinutes ?? DEFAULT_TTL_MINUTES
  const expiresAt = new Date(now.getTime() + ttl * 60_000)
  const maxUses = input.maxUses ?? DEFAULT_MAX_USES

  // The synthetic member carries no email, so nothing is invented and it is
  // unreachable through the Google sign-in path.
  await upsertMember(deps, {
    memberId: qaMemberId,
    email: '',
    displayName: input.label ?? 'QA session',
    role: 'member',
    status: 'active',
    isSynthetic: true,
  })

  await deps.qaSessions.createEntity({
    partitionKey: QA_PARTITION,
    rowKey: qaSessionRowKey(code), // the hash IS the key; the code is not stored
    kind: 'qa-session',
    linkId,
    qaMemberId,
    expiresAt,
    maxUses,
    usedCount: 0,
    failedCount: 0,
    createdByMemberId: actorMemberId,
    createdAt: now,
  })

  return { linkId, code, qaMemberId, expiresAt, maxUses }
}

export interface RedeemedQaSession {
  qaMemberId: string
  customToken: string
  expiresAt: Date
}

export async function redeemQaLink(deps: QaDeps, code: string): Promise<RedeemedQaSession> {
  if (typeof code !== 'string' || code.length < 16) throw new QaLinkInvalidError()
  const now = deps.now?.() ?? new Date()

  let row: Record<string, unknown>
  try {
    row = (await deps.qaSessions.getEntity(
      QA_PARTITION,
      qaSessionRowKey(code),
    )) as Record<string, unknown>
  } catch (err) {
    if (isNotFound(err)) throw new QaLinkInvalidError()
    throw err
  }

  if (row.revokedAt) throw new QaLinkInvalidError()
  if (new Date(String(row.expiresAt)).getTime() <= now.getTime()) throw new QaLinkInvalidError()

  const usedCount = Number(row.usedCount ?? 0)
  const maxUses = Number(row.maxUses ?? 1)
  if (usedCount >= maxUses) throw new QaLinkInvalidError()
  if (Number(row.failedCount ?? 0) >= MAX_FAILED_ATTEMPTS) throw new QaLinkInvalidError()

  // The ETag-guarded increment is what makes replay impossible: two concurrent
  // redemptions of a single-use link cannot both commit, so the check is the
  // write rather than a read that could race.
  try {
    await deps.qaSessions.updateEntity(
      { partitionKey: QA_PARTITION, rowKey: String(row.rowKey), usedCount: usedCount + 1 },
      'Merge',
      { etag: String(row.etag) },
    )
  } catch (err) {
    if (isPreconditionFailed(err)) throw new QaLinkInvalidError()
    throw err
  }

  const qaMemberId = String(row.qaMemberId)
  const customToken = await mintCustomToken(deps.serviceAccount, {
    uid: qaMemberId,
    claims: { qa: true, role: 'member' },
    ...(deps.signingKey ? { signingKey: deps.signingKey } : {}),
  })

  return { qaMemberId, customToken, expiresAt: new Date(String(row.expiresAt)) }
}

/**
 * Revocation is two-sided: the link stops redeeming, and the synthetic member
 * is disabled so any token already issued from it dies at the next request.
 */
export async function revokeQaLink(deps: QaDeps, linkId: string): Promise<void> {
  const now = deps.now?.() ?? new Date()
  const iter = deps.qaSessions.listEntities({
    queryOptions: { filter: odata`PartitionKey eq ${QA_PARTITION} and linkId eq ${linkId}` },
  })

  for await (const e of iter) {
    const row = e as Record<string, unknown>
    await deps.qaSessions.updateEntity(
      { partitionKey: QA_PARTITION, rowKey: String(row.rowKey), revokedAt: now },
      'Merge',
    )
    await setMemberStatus(deps, String(row.qaMemberId), 'disabled')
    return
  }
  throw new QaLinkInvalidError()
}

export async function listQaLinks(deps: QaDeps): Promise<
  Array<{ linkId: string; qaMemberId: string; expiresAt: Date; usedCount: number; maxUses: number; revoked: boolean }>
> {
  const out = []
  const iter = deps.qaSessions.listEntities({
    queryOptions: { filter: odata`PartitionKey eq ${QA_PARTITION}` },
  })
  for await (const e of iter) {
    const row = e as Record<string, unknown>
    out.push({
      linkId: String(row.linkId),
      qaMemberId: String(row.qaMemberId),
      expiresAt: new Date(String(row.expiresAt)),
      usedCount: Number(row.usedCount ?? 0),
      maxUses: Number(row.maxUses ?? 1),
      revoked: Boolean(row.revokedAt),
    })
  }
  return out
}

/** Constant-time comparison helper for any future non-hashed comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}
