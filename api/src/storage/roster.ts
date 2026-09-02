import { odata, type TableClient, type TransactionAction } from '@azure/data-tables'

import {
  ROSTER_PARTITION,
  memberRowKey,
  emailIndexRowKey,
  normalizeEmail,
  MEMBER_RANGE,
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
