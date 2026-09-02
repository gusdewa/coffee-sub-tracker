import { odata, type TableClient, type TransactionAction } from '@azure/data-tables'

import {
  ROSTER_PARTITION,
  memberRowKey,
  emailIndexRowKey,
  normalizeEmail,
  MEMBER_RANGE,
  LINK_AUDIT_RANGE,
  linkAuditRowKey,
} from './keys.js'
import { isNotFound } from './tableClient.js'
import type { MemberEntity, MemberRole, MemberStatus } from './entities.js'

/**
 * The roster is the authorization boundary: a verified Google identity grants
 * nothing until it maps to an active row here.
 *
 * The member record and its email index share the `ROSTER` partition, so
 * creating or renaming a member writes both rows in one entity-group
 * transaction. Splitting them across partitions would have reintroduced the
 * very inconsistency the two-phase batch flow exists to manage.
 */

export interface Member {
  memberId: string
  email: string
  displayName: string
  role: MemberRole
  status: MemberStatus
  firebaseUid: string
  isSynthetic: boolean
}

function toMember(row: Record<string, unknown>): Member {
  return {
    memberId: String(row.memberId ?? ''),
    email: String(row.email ?? ''),
    displayName: String(row.displayName ?? ''),
    role: (String(row.role ?? 'member') as MemberRole),
    status: (String(row.status ?? 'active') as MemberStatus),
    firebaseUid: String(row.firebaseUid ?? ''),
    isSynthetic: Boolean(row.isSynthetic ?? false),
  }
}

/**
 * Short-lived positive cache. The TTL is the upper bound on how long a
 * disabled member keeps working, so it is deliberately small and configurable
 * down to zero for tests.
 */
export class RosterCache {
  private readonly entries = new Map<string, { value: Member | null; expires: number }>()
  constructor(private readonly ttlMs: number = 60_000) {}

  get(key: string): Member | null | undefined {
    if (this.ttlMs <= 0) return undefined
    const hit = this.entries.get(key)
    if (!hit) return undefined
    if (Date.now() > hit.expires) {
      this.entries.delete(key)
      return undefined
    }
    return hit.value
  }

  set(key: string, value: Member | null): void {
    if (this.ttlMs <= 0) return
    this.entries.set(key, { value, expires: Date.now() + this.ttlMs })
  }

  clear(): void {
    this.entries.clear()
  }
}

export interface RosterDeps {
  members: TableClient
  cache?: RosterCache
}

export async function findMemberById(
  deps: RosterDeps,
  memberId: string,
): Promise<Member | undefined> {
  const cacheKey = `id:${memberId}`
  const cached = deps.cache?.get(cacheKey)
  if (cached !== undefined) return cached ?? undefined

  try {
    const row = (await deps.members.getEntity(
      ROSTER_PARTITION,
      memberRowKey(memberId),
    )) as Record<string, unknown>
    const member = toMember(row)
    deps.cache?.set(cacheKey, member)
    return member
  } catch (err) {
    if (isNotFound(err)) {
      deps.cache?.set(cacheKey, null)
      return undefined
    }
    throw err
  }
}

export async function findMemberByEmail(
  deps: RosterDeps,
  email: string,
): Promise<Member | undefined> {
  const normalized = normalizeEmail(email)
  const cacheKey = `email:${normalized}`
  const cached = deps.cache?.get(cacheKey)
  if (cached !== undefined) return cached ?? undefined

  let memberId: string
  try {
    const idx = (await deps.members.getEntity(
      ROSTER_PARTITION,
      emailIndexRowKey(normalized),
    )) as Record<string, unknown>
    memberId = String(idx.memberId)
  } catch (err) {
    if (isNotFound(err)) {
      deps.cache?.set(cacheKey, null)
      return undefined
    }
    throw err
  }

  const member = await findMemberById({ members: deps.members }, memberId)
  deps.cache?.set(cacheKey, member ?? null)
  return member
}

export interface UpsertMemberInput {
  memberId: string
  email: string
  displayName: string
  role: MemberRole
  status: MemberStatus
  firebaseUid?: string
  isSynthetic?: boolean
}

/**
 * Writes the member row and, when the member has an address, its email index —
 * atomically, because both live in the ROSTER partition.
 */
export async function upsertMember(deps: RosterDeps, input: UpsertMemberInput): Promise<void> {
  const now = new Date()
  const entity: Omit<MemberEntity, 'etag' | 'timestamp'> = {
    partitionKey: ROSTER_PARTITION,
    rowKey: memberRowKey(input.memberId),
    kind: 'member',
    memberId: input.memberId,
    email: normalizeEmail(input.email ?? ''),
    displayName: input.displayName,
    role: input.role,
    status: input.status,
    firebaseUid: input.firebaseUid ?? '',
    isSynthetic: input.isSynthetic ?? false,
    createdAt: now,
  }

  const actions: TransactionAction[] = [['upsert', entity, 'Replace']]
  if (entity.email) {
    actions.push([
      'upsert',
      {
        partitionKey: ROSTER_PARTITION,
        rowKey: emailIndexRowKey(entity.email),
        kind: 'email-index',
        memberId: input.memberId,
      },
      'Replace',
    ])
  }
  await deps.members.submitTransaction(actions)
  deps.cache?.clear()
}

export async function listMembers(deps: RosterDeps): Promise<Member[]> {
  const out: Member[] = []
  const iter = deps.members.listEntities({
    queryOptions: {
      filter: odata`PartitionKey eq ${ROSTER_PARTITION} and RowKey ge ${MEMBER_RANGE.from} and RowKey lt ${MEMBER_RANGE.to}`,
    },
  })
  for await (const e of iter) out.push(toMember(e as Record<string, unknown>))
  return out
}

export async function setMemberStatus(
  deps: RosterDeps,
  memberId: string,
  status: MemberStatus,
): Promise<void> {
  await deps.members.updateEntity(
    { partitionKey: ROSTER_PARTITION, rowKey: memberRowKey(memberId), status },
    'Merge',
  )
  deps.cache?.clear()
}

// --- pending members and address linking -----------------------------------

/**
 * A member may exist with **no address**. That is the normal state for someone
 * whose personal Google account has not been confirmed: we know who they are,
 * an admin can already allocate cups to them, but nobody can sign in as them.
 *
 * Guessing an address from a corporate alias would silently hand one person's
 * balance to whoever happens to own that Gmail, so an unlinked member stays
 * unlinked until an admin supplies the exact address.
 */
export class MemberNotFoundError extends Error {
  readonly code = 'MEMBER_NOT_FOUND'
  constructor() {
    super('No such member')
    this.name = 'MemberNotFoundError'
  }
}

export class EmailAlreadyLinkedError extends Error {
  readonly code = 'EMAIL_ALREADY_LINKED'
  constructor() {
    super('That address is already linked to a member')
    this.name = 'EmailAlreadyLinkedError'
  }
}

export class MemberAlreadyLinkedError extends Error {
  readonly code = 'MEMBER_ALREADY_LINKED'
  constructor() {
    super('That member already has an address. Unlink it first.')
    this.name = 'MemberAlreadyLinkedError'
  }
}

export class LinkDomainError extends Error {
  readonly code = 'VALIDATION_FAILED'
  constructor(domain: string) {
    super(`Only @${domain} addresses can be linked`)
    this.name = 'LinkDomainError'
  }
}

export const isPending = (m: Member): boolean => m.email === ''

export interface LinkEmailInput {
  actorMemberId: string
  memberId: string
  email: string
  opId: string
  allowedDomain: string
  /**
   * How the link came about. A self-claim is a person binding their own
   * freshly signed-in account; an admin link is someone doing it on their
   * behalf. Both are audited, and the distinction is what lets an admin review
   * self-claims without wading through their own actions.
   */
  via?: 'admin' | 'self'
}

/**
 * Link an exact address to a pending member.
 *
 * Uniqueness is the insert of `E|<hash>`, not a prior lookup: two admins racing
 * to attach the same address cannot both succeed, because the second insert
 * collides. The member update and the audit row ride in the same transaction,
 * so a link can never exist without its audit entry.
 */
export async function linkMemberEmail(deps: RosterDeps, input: LinkEmailInput): Promise<Member> {
  const email = normalizeEmail(input.email)
  const domain = input.allowedDomain.toLowerCase()
  if (!email.includes('@') || !email.endsWith(`@${domain}`)) throw new LinkDomainError(domain)

  let row: Record<string, unknown>
  try {
    row = (await deps.members.getEntity(
      ROSTER_PARTITION,
      memberRowKey(input.memberId),
    )) as Record<string, unknown>
  } catch (err) {
    if (isNotFound(err)) throw new MemberNotFoundError()
    throw err
  }

  const current = toMember(row)
  if (current.email) throw new MemberAlreadyLinkedError()

  const at = new Date()
  const actions: TransactionAction[] = [
    // The uniqueness claim. A duplicate address fails the whole transaction.
    [
      'create',
      {
        partitionKey: ROSTER_PARTITION,
        rowKey: emailIndexRowKey(email),
        kind: 'email-index',
        memberId: input.memberId,
      },
    ],
    [
      'update',
      { partitionKey: ROSTER_PARTITION, rowKey: memberRowKey(input.memberId), email },
      'Merge',
      { etag: String(row.etag) },
    ],
    [
      'create',
      {
        partitionKey: ROSTER_PARTITION,
        rowKey: linkAuditRowKey(at, input.opId),
        kind: 'link-audit',
        action: 'link',
        via: input.via ?? 'admin',
        actorMemberId: input.actorMemberId,
        memberId: input.memberId,
        email,
        createdAt: at,
      },
    ],
  ]

  try {
    await deps.members.submitTransaction(actions)
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode
    if (status === 409) throw new EmailAlreadyLinkedError()
    if (status === 412) throw new MemberAlreadyLinkedError() // changed under us
    throw err
  }

  deps.cache?.clear()
  return { ...current, email }
}

export interface LinkAuditEntry {
  action: 'link' | 'unlink'
  via: 'admin' | 'self'
  actorMemberId: string
  memberId: string
  email: string
  createdAt: string
}

/** Append-only history of who linked which address to whom. */
export async function listLinkAudit(deps: RosterDeps): Promise<LinkAuditEntry[]> {
  const out: LinkAuditEntry[] = []
  const iter = deps.members.listEntities({
    queryOptions: {
      filter: odata`PartitionKey eq ${ROSTER_PARTITION} and RowKey ge ${LINK_AUDIT_RANGE.from} and RowKey lt ${LINK_AUDIT_RANGE.to}`,
    },
  })
  for await (const e of iter) {
    const r = e as Record<string, unknown>
    out.push({
      action: (String(r.action ?? 'link') as 'link' | 'unlink'),
      via: (String(r.via ?? 'admin') as 'admin' | 'self'),
      actorMemberId: String(r.actorMemberId ?? ''),
      memberId: String(r.memberId ?? ''),
      email: String(r.email ?? ''),
      createdAt: new Date(String(r.createdAt)).toISOString(),
    })
  }
  return out
}

/**
 * Admin override: detach an address from a member.
 *
 * This is the correction path for a self-claim that went to the wrong person.
 * It frees the address so it can be claimed again, and it deletes the index row
 * rather than tombstoning it — a stale index row would keep the address
 * permanently unusable. The member keeps its id, so its ledger partition and
 * balance survive the correction untouched.
 */
export async function unlinkMemberEmail(
  deps: RosterDeps,
  input: { actorMemberId: string; memberId: string; opId: string },
): Promise<void> {
  let row: Record<string, unknown>
  try {
    row = (await deps.members.getEntity(
      ROSTER_PARTITION,
      memberRowKey(input.memberId),
    )) as Record<string, unknown>
  } catch (err) {
    if (isNotFound(err)) throw new MemberNotFoundError()
    throw err
  }

  const current = toMember(row)
  if (!current.email) return // already unlinked; nothing to correct

  const at = new Date()
  // The member update and the audit entry commit together. The index row is
  // removed separately because a delete cannot share an entity-group
  // transaction with a conditional update on a different row key here without
  // pinning both ETags, and the index is derivable from the member row.
  await deps.members.submitTransaction([
    [
      'update',
      { partitionKey: ROSTER_PARTITION, rowKey: memberRowKey(input.memberId), email: '' },
      'Merge',
      { etag: String(row.etag) },
    ],
    [
      'create',
      {
        partitionKey: ROSTER_PARTITION,
        rowKey: linkAuditRowKey(at, input.opId),
        kind: 'link-audit',
        action: 'unlink',
        via: 'admin',
        actorMemberId: input.actorMemberId,
        memberId: input.memberId,
        email: current.email,
        createdAt: at,
      },
    ],
  ])

  await deps.members
    .deleteEntity(ROSTER_PARTITION, emailIndexRowKey(current.email))
    .catch((err: unknown) => {
      if (!isNotFound(err)) throw err
    })

  deps.cache?.clear()
}
