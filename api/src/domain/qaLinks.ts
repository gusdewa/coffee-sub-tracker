import { randomBytes } from 'node:crypto'
import { odata, type TableClient } from '@azure/data-tables'
import { ulid } from 'ulid'

import {
  QA_PARTITION,
  qaLinkRowKey,
  qaSessionRowKey,
  QA_LINK_RANGE,
} from '../storage/keys.js'
import { isNotFound, isPreconditionFailed } from '../storage/tableClient.js'
import { upsertMember, setMemberStatus, type RosterDeps } from '../storage/roster.js'

/**
 * Short-lived, revocable, single-use QA links.
 *
 * **No dependency on Firebase.** Redeeming a link mints an opaque, server-issued
 * session token rather than a Firebase custom token, so QA works whether or not
 * Identity Platform has been initialised — and the system needs no signing key,
 * which means it now holds no secrets at all.
 *
 * The trade-off is a second bearer type in the client. That is the shape a
 * backdoor takes, so it is deliberately narrow: a QA session resolves to a
 * synthetic, non-admin member in its own ledger partition, is checked against
 * storage on every request (so revocation is immediate rather than waiting for
 * an expiry), and can never reach an admin route.
 *
 * Neither the link code nor the session token is ever stored in the clear —
 * only their SHA-256, as the row key.
 */

const CODE_BYTES = 32 // 256 bits
const SESSION_BYTES = 32 // 256 bits
const DEFAULT_TTL_MINUTES = 120
const DEFAULT_SESSION_MINUTES = 60
const DEFAULT_MAX_USES = 1

export class QaLinkInvalidError extends Error {
  readonly code = 'QA_LINK_INVALID'
  constructor() {
    // One message for absent, expired, spent and revoked alike: distinguishing
    // them would let a caller probe which codes exist.
    super('That QA link is not valid')
    this.name = 'QaLinkInvalidError'
  }
}

export class QaSessionInvalidError extends Error {
  readonly code = 'UNAUTHENTICATED'
  constructor() {
    super('QA session is not valid')
    this.name = 'QaSessionInvalidError'
  }
}

export interface QaDeps extends RosterDeps {
  qaSessions: TableClient
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
  const expiresAt = new Date(now.getTime() + (input.ttlMinutes ?? DEFAULT_TTL_MINUTES) * 60_000)
  const maxUses = input.maxUses ?? DEFAULT_MAX_USES

  // The synthetic member carries no address, so nothing is invented and it is
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
    rowKey: qaLinkRowKey(code), // the hash IS the key; the code is not stored
    kind: 'qa-link',
    linkId,
    qaMemberId,
    expiresAt,
    maxUses,
    usedCount: 0,
    createdByMemberId: actorMemberId,
    createdAt: now,
  })

  return { linkId, code, qaMemberId, expiresAt, maxUses }
}

export interface RedeemedQaSession {
  qaMemberId: string
  /** Opaque bearer token. Returned once; only its hash is stored. */
  sessionToken: string
  expiresAt: Date
}

export async function redeemQaLink(deps: QaDeps, code: string): Promise<RedeemedQaSession> {
  if (typeof code !== 'string' || code.length < 16) throw new QaLinkInvalidError()
  const now = deps.now?.() ?? new Date()

  let row: Record<string, unknown>
  try {
    row = (await deps.qaSessions.getEntity(
      QA_PARTITION,
      qaLinkRowKey(code),
    )) as Record<string, unknown>
  } catch (err) {
    if (isNotFound(err)) throw new QaLinkInvalidError()
    throw err
  }

  if (row.revokedAt) throw new QaLinkInvalidError()
  if (new Date(String(row.expiresAt)).getTime() <= now.getTime()) throw new QaLinkInvalidError()

  const usedCount = Number(row.usedCount ?? 0)
  if (usedCount >= Number(row.maxUses ?? 1)) throw new QaLinkInvalidError()

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

  const sessionToken = randomBytes(SESSION_BYTES).toString('base64url')
  const sessionExpiry = new Date(
    Math.min(
      now.getTime() + DEFAULT_SESSION_MINUTES * 60_000,
      new Date(String(row.expiresAt)).getTime(),
    ),
  )

  await deps.qaSessions.createEntity({
    partitionKey: QA_PARTITION,
    rowKey: qaSessionRowKey(sessionToken),
    kind: 'qa-session',
    linkId: String(row.linkId),
    qaMemberId: String(row.qaMemberId),
    expiresAt: sessionExpiry,
    createdAt: now,
  })

  return { qaMemberId: String(row.qaMemberId), sessionToken, expiresAt: sessionExpiry }
}

/**
 * Resolve a session token to its synthetic member.
 *
 * Deliberately a storage read on every request: a signed token would keep
 * working until it expired, whereas this dies the moment the row is deleted.
 */
export async function resolveQaSession(deps: QaDeps, token: string): Promise<string> {
  if (typeof token !== 'string' || token.length < 16) throw new QaSessionInvalidError()
  const now = deps.now?.() ?? new Date()

  let row: Record<string, unknown>
  try {
    row = (await deps.qaSessions.getEntity(
      QA_PARTITION,
      qaSessionRowKey(token),
    )) as Record<string, unknown>
  } catch (err) {
    if (isNotFound(err)) throw new QaSessionInvalidError()
    throw err
  }

  if (new Date(String(row.expiresAt)).getTime() <= now.getTime()) throw new QaSessionInvalidError()
  return String(row.qaMemberId)
}

/**
 * Revocation is three-sided: the link stops redeeming, every session minted
 * from it is deleted, and the synthetic member is disabled — so an issued
 * token dies on its next request even if a session row were missed.
 */
export async function revokeQaLink(deps: QaDeps, linkId: string): Promise<void> {
  const now = deps.now?.() ?? new Date()
  let found = false

  for await (const e of deps.qaSessions.listEntities({
    queryOptions: { filter: odata`PartitionKey eq ${QA_PARTITION} and linkId eq ${linkId}` },
  })) {
    const row = e as Record<string, unknown>
    const rowKey = String(row.rowKey)

    if (row.kind === 'qa-session') {
      await deps.qaSessions.deleteEntity(QA_PARTITION, rowKey)
      continue
    }

    found = true
    await deps.qaSessions.updateEntity(
      { partitionKey: QA_PARTITION, rowKey, revokedAt: now },
      'Merge',
    )
    await setMemberStatus(deps, String(row.qaMemberId), 'disabled')
  }

  if (!found) throw new QaLinkInvalidError()
}

export interface QaLinkSummary {
  linkId: string
  qaMemberId: string
  expiresAt: Date
  usedCount: number
  maxUses: number
  revoked: boolean
}

export async function listQaLinks(deps: QaDeps): Promise<QaLinkSummary[]> {
  const out: QaLinkSummary[] = []
  const iter = deps.qaSessions.listEntities({
    queryOptions: {
      filter: odata`PartitionKey eq ${QA_PARTITION} and RowKey ge ${QA_LINK_RANGE.from} and RowKey lt ${QA_LINK_RANGE.to}`,
    },
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
