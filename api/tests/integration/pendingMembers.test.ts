import { describe, test, beforeAll, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet, type JWK } from 'jose'
import type { TableClient } from '@azure/data-tables'

import { createTableClient, ensureTablesExist, azuriteConnectionString } from '../../src/storage/tableClient.js'
import { TABLES } from '../../src/storage/entities.js'
import {
  upsertMember,
  linkMemberEmail,
  listLinkAudit,
  findMemberById,
  findMemberByEmail,
  isPending,
  RosterCache,
  EmailAlreadyLinkedError,
  MemberAlreadyLinkedError,
  MemberNotFoundError,
  LinkDomainError,
  type RosterDeps,
} from '../../src/storage/roster.js'
import { createTokenVerifier } from '../../src/auth/verifyFirebaseToken.js'
import { authorize, UnboundAccountError } from '../../src/auth/authorize.js'
import { createBatch } from '../../src/domain/batches.js'
import { consumeOne } from '../../src/domain/consume.js'

process.env.AZURE_TABLES_CONNECTION_STRING ??= azuriteConnectionString()

const PROJECT_ID = 'coffee-sub-tracker-f4551d'
const DOMAIN = 'gmail.com'
const OPTS = { allowedEmailDomain: DOMAIN }
const ADMIN = 'PENDADMIN0000000000000AAAA'

let deps: RosterDeps
let ledger: TableClient
let batches: TableClient
let verify: ReturnType<typeof createTokenVerifier>
let privateKey: CryptoKey

const newId = () => `P${randomUUID().replace(/-/g, '').toUpperCase().slice(0, 25)}`
const gmail = () => `coffee.${randomUUID().slice(0, 8)}@gmail.com`

async function token(sub: string, email?: string): Promise<string> {
  const payload: Record<string, unknown> = {
    firebase: { sign_in_provider: 'google.com' },
  }
  if (email) {
    payload.email = email
    payload.email_verified = true
  }
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256' })
    .setSubject(sub)
    .setIssuer(`https://securetoken.google.com/${PROJECT_ID}`)
    .setAudience(PROJECT_ID)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey)
}

beforeAll(async () => {
  await ensureTablesExist()
  deps = { members: createTableClient(TABLES.members), cache: new RosterCache(0) }
  ledger = createTableClient(TABLES.ledger)
  batches = createTableClient(TABLES.batches)

  const pair = await generateKeyPair('RS256', { extractable: true })
  privateKey = pair.privateKey
  const jwk = (await exportJWK(pair.publicKey)) as JWK
  jwk.alg = 'RS256'
  verify = createTokenVerifier({ projectId: PROJECT_ID, jwks: createLocalJWKSet({ keys: [jwk] }) })
})

async function seedPending(displayName: string): Promise<string> {
  const memberId = newId()
  await upsertMember(deps, {
    memberId, email: '', displayName, role: 'member', status: 'active',
  })
  return memberId
}

describe('a member may exist without an address', () => {
  test('a pending member is on the roster and is marked pending', async () => {
    const id = await seedPending('Pending Person')
    const m = await findMemberById(deps, id)
    expect(m).toBeDefined()
    expect(m!.email).toBe('')
    expect(isPending(m!)).toBe(true)
  })

  test('a pending member is never matched by a guessed address', async () => {
    const id = await seedPending('Cannot Sign In')
    // A plausible-looking address resolves to nobody. The account is *unbound*
    // — it may claim an identity deliberately, but nothing is ever inferred.
    const t = await verify(await token('uid-guess', 'plausible.guess@gmail.com'))
    await expect(authorize(deps, t, OPTS)).rejects.toBeInstanceOf(UnboundAccountError)
    expect((await findMemberById(deps, id))!.email).toBe('')
  })

  test('an admin can allocate cups to a pending member before they are linked', async () => {
    const id = await seedPending('Gets Coffee Early')
    await createBatch({ ledger, batches }, ADMIN, {
      label: 'Pre-allocation', allocations: [{ memberId: id, units: 3 }],
    })
    const drink = await consumeOne({ ledger }, id, randomUUID())
    expect(drink.remainingTotal).toBe(2)
  })
})

describe('linking an exact address (plan: admin-only, unique, audited)', () => {
  test('linking lets the member sign in, and preserves their balance', async () => {
    const id = await seedPending('Links Later')
    await createBatch({ ledger, batches }, ADMIN, {
      label: 'Held for them', allocations: [{ memberId: id, units: 4 }],
    })

    const email = gmail()
    await linkMemberEmail(deps, {
      actorMemberId: ADMIN, memberId: id, email, opId: randomUUID(), allowedDomain: DOMAIN,
    })

    const ctx = await authorize(deps, await verify(await token('uid-link', email)), OPTS)
    expect(ctx.memberId).toBe(id)

    // The ledger partition is keyed by member id, so linking cannot orphan it.
    const drink = await consumeOne({ ledger }, ctx.memberId, randomUUID())
    expect(drink.remainingTotal).toBe(3)
  })

  test('an address can belong to only one member', async () => {
    const first = await seedPending('First Claimant')
    const second = await seedPending('Second Claimant')
    const email = gmail()

    await linkMemberEmail(deps, {
      actorMemberId: ADMIN, memberId: first, email, opId: randomUUID(), allowedDomain: DOMAIN,
    })
    await expect(
      linkMemberEmail(deps, {
        actorMemberId: ADMIN, memberId: second, email, opId: randomUUID(), allowedDomain: DOMAIN,
      }),
    ).rejects.toBeInstanceOf(EmailAlreadyLinkedError)

    expect((await findMemberByEmail(deps, email))!.memberId).toBe(first)
    expect((await findMemberById(deps, second))!.email).toBe('')
  })

  test('two admins racing to claim one address produce exactly one link', async () => {
    const email = gmail()
    const candidates = await Promise.all([
      seedPending('Race A'), seedPending('Race B'), seedPending('Race C'),
    ])

    const settled = await Promise.allSettled(
      candidates.map((memberId) =>
        linkMemberEmail(deps, {
          actorMemberId: ADMIN, memberId, email, opId: randomUUID(), allowedDomain: DOMAIN,
        }),
      ),
    )
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1)

    const linked = await findMemberByEmail(deps, email)
    expect(candidates).toContain(linked!.memberId)
  })

  test('a member who already has an address is not silently relinked', async () => {
    const id = await seedPending('Already Linked')
    await linkMemberEmail(deps, {
      actorMemberId: ADMIN, memberId: id, email: gmail(), opId: randomUUID(), allowedDomain: DOMAIN,
    })
    await expect(
      linkMemberEmail(deps, {
        actorMemberId: ADMIN, memberId: id, email: gmail(), opId: randomUUID(), allowedDomain: DOMAIN,
      }),
    ).rejects.toBeInstanceOf(MemberAlreadyLinkedError)
  })

  test('only the permitted domain can be linked', async () => {
    const id = await seedPending('Wrong Domain')
    for (const bad of ['someone@sinarmas-agri.com', 'someone@example.com', 'someone@googlemail.com', 'notanemail']) {
      await expect(
        linkMemberEmail(deps, {
          actorMemberId: ADMIN, memberId: id, email: bad, opId: randomUUID(), allowedDomain: DOMAIN,
        }),
      ).rejects.toBeInstanceOf(LinkDomainError)
    }
    expect((await findMemberById(deps, id))!.email).toBe('')
  })

  test('linking an unknown member is refused', async () => {
    await expect(
      linkMemberEmail(deps, {
        actorMemberId: ADMIN, memberId: newId(), email: gmail(), opId: randomUUID(), allowedDomain: DOMAIN,
      }),
    ).rejects.toBeInstanceOf(MemberNotFoundError)
  })

  test('every successful link writes an audit entry naming the admin', async () => {
    const id = await seedPending('Audited Link')
    const email = gmail()
    await linkMemberEmail(deps, {
      actorMemberId: ADMIN, memberId: id, email, opId: randomUUID(), allowedDomain: DOMAIN,
    })

    const audit = await listLinkAudit(deps)
    const entry = audit.find((a) => a.memberId === id)
    expect(entry).toBeDefined()
    expect(entry!.actorMemberId).toBe(ADMIN)
    expect(entry!.email).toBe(email)
  })

  test('a failed link leaves no audit entry and no partial state', async () => {
    const taken = await seedPending('Holder')
    const loser = await seedPending('Loser')
    const email = gmail()
    await linkMemberEmail(deps, {
      actorMemberId: ADMIN, memberId: taken, email, opId: randomUUID(), allowedDomain: DOMAIN,
    })

    const before = (await listLinkAudit(deps)).length
    await expect(
      linkMemberEmail(deps, {
        actorMemberId: ADMIN, memberId: loser, email, opId: randomUUID(), allowedDomain: DOMAIN,
      }),
    ).rejects.toBeInstanceOf(EmailAlreadyLinkedError)

    expect((await listLinkAudit(deps)).length).toBe(before)
    expect((await findMemberById(deps, loser))!.email).toBe('')
  })
})
