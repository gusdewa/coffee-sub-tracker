import { describe, test, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import type { TableClient } from '@azure/data-tables'

import { createApp } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import { createTableClient, ensureTablesExist, azuriteConnectionString } from '../../src/storage/tableClient.js'
import { TABLES } from '../../src/storage/entities.js'
import { RosterCache, upsertMember, findMemberById, listLinkAudit } from '../../src/storage/roster.js'
import type { VerifiedToken } from '../../src/auth/verifyFirebaseToken.js'
import { UnauthenticatedError } from '../../src/auth/verifyFirebaseToken.js'
import { predictMember, identityTokens } from '../../src/domain/predictMember.js'

process.env.AZURE_TABLES_CONNECTION_STRING ??= azuriteConnectionString()

const DOMAIN = 'gmail.com'
const ORIGIN = 'https://gusdewa.github.io'

let members: TableClient
let app: ReturnType<typeof createApp>
let roster: { members: TableClient; cache: RosterCache }

const ADMIN_ID = 'CLAIMADMIN000000000000AAA'
const suffix = randomUUID().slice(0, 6)
const NAMES = ['Andri', 'Roy', 'Albert'] as const
const pendingIds: Record<string, string> = {}

/** The token string is "<email>|<displayName>"; identity comes from it alone. */
const verifier = async (token: string): Promise<VerifiedToken> => {
  if (!token) throw new UnauthenticatedError('missing token')
  const [email, name] = token.split('|')
  return {
    uid: `uid-${email}`,
    email,
    emailVerified: true,
    displayName: name || undefined,
    signInProvider: 'google.com',
    qa: false,
    payload: {},
  }
}

const as = (email: string, name = '') => ({ Authorization: `Bearer ${email}|${name}` })

beforeAll(async () => {
  await ensureTablesExist()
  members = createTableClient(TABLES.members)
  roster = { members, cache: new RosterCache(0) }

  await upsertMember(roster, {
    memberId: ADMIN_ID, email: `claimadmin.${suffix}@gmail.com`, displayName: 'Claim Admin',
    role: 'admin', status: 'active',
  })
  for (const n of NAMES) {
    const id = `C${randomUUID().replace(/-/g, '').toUpperCase().slice(0, 25)}`
    pendingIds[n] = id
    await upsertMember(roster, {
      memberId: id, email: '', displayName: `${n}${suffix}`, role: 'member', status: 'active',
    })
  }

  app = createApp({
    config: { ...loadConfig(), rosterCacheTtlMs: 0, allowedEmailDomain: DOMAIN, allowedOrigin: ORIGIN },
    members,
    ledger: createTableClient(TABLES.ledger),
    batches: createTableClient(TABLES.batches),
    qaSessions: createTableClient(TABLES.qaSessions),
    verifier,
  })
})

describe('prediction is a convenience, never an authority', () => {
  const candidates = [
    { memberId: 'a', displayName: 'Andri' },
    { memberId: 'r', displayName: 'Roy' },
    { memberId: 'b', displayName: 'Albert' },
  ]

  test('an exact first-name match is predicted', () => {
    expect(predictMember(candidates, 'Andri Mirandi', 'whoever@gmail.com').memberId).toBe('a')
  })

  test('the address local part is used when the display name is absent', () => {
    expect(predictMember(candidates, undefined, 'roy.something@gmail.com').memberId).toBe('r')
  })

  test('an ambiguous tie predicts nothing rather than guessing', () => {
    const twins = [
      { memberId: 'x', displayName: 'Andri' },
      { memberId: 'y', displayName: 'Andri' },
    ]
    expect(predictMember(twins, 'Andri', 'andri@gmail.com').memberId).toBeUndefined()
  })

  test('an unrelated identity predicts nothing', () => {
    const p = predictMember(candidates, 'Zebedee Quackenbush', 'zq@gmail.com')
    expect(p.memberId).toBeUndefined()
    expect(p.confidence).toBe(0)
  })

  test('tokens ignore digits and punctuation in the local part', () => {
    expect(identityTokens(undefined, 'roy.hutagaol99@gmail.com')).toContain('roy')
  })
})

describe('claim options', () => {
  test('an unbound account is offered the pending members and a prediction', async () => {
    const res = await request(app)
      .get('/api/claim/options')
      .set(as(`newcomer.${suffix}@gmail.com`, `Andri${suffix} Mirandi`))
      .expect(200)

    expect(res.body.bound).toBe(false)
    const names = res.body.candidates.map((c: { displayName: string }) => c.displayName)
    for (const n of NAMES) expect(names).toContain(`${n}${suffix}`)
    expect(res.body.prediction.memberId).toBe(pendingIds.Andri)
  })

  test('an already-bound account is told so, and offered nothing to claim', async () => {
    const res = await request(app)
      .get('/api/claim/options')
      .set(as(`claimadmin.${suffix}@gmail.com`, 'Claim Admin'))
      .expect(200)
    expect(res.body.bound).toBe(true)
    expect(res.body.candidates).toBeUndefined()
  })
})

describe('self-claim binds immediately, once, and is audited', () => {
  test('claiming binds the account and lets it sign in', async () => {
    const email = `roy.claimer.${suffix}@gmail.com`
    const res = await request(app)
      .post('/api/claim')
      .set(as(email, 'Roy'))
      .set('Idempotency-Key', randomUUID())
      .send({ memberId: pendingIds.Roy })
      .expect(200)

    expect(res.body.bound).toBe(true)
    expect((await findMemberById(roster, pendingIds.Roy!))!.email).toBe(email)

    // The bound account now resolves normally.
    const me = await request(app).get('/api/me').set(as(email, 'Roy')).expect(200)
    expect(me.body.member.memberId).toBe(pendingIds.Roy)
  })

  test('the audit records it as a self-claim, not an admin action', async () => {
    const entries = await listLinkAudit(roster)
    const entry = entries.find((e) => e.memberId === pendingIds.Roy)
    expect(entry).toBeDefined()
    expect(entry!.via).toBe('self')
    expect(entry!.action).toBe('link')
    // The claimant acted as themselves.
    expect(entry!.actorMemberId).toBe(pendingIds.Roy)
  })

  test('a claimed member cannot be claimed again by someone else', async () => {
    const res = await request(app)
      .post('/api/claim')
      .set(as(`impostor.${suffix}@gmail.com`, 'Roy'))
      .set('Idempotency-Key', randomUUID())
      .send({ memberId: pendingIds.Roy })
      .expect(409)
    expect(res.body.error.code).toBe('NOT_CLAIMABLE')
  })

  test('an already-bound account cannot claim a second identity', async () => {
    const res = await request(app)
      .post('/api/claim')
      .set(as(`claimadmin.${suffix}@gmail.com`, 'Claim Admin'))
      .set('Idempotency-Key', randomUUID())
      .send({ memberId: pendingIds.Albert })
      .expect(409)
    expect(res.body.error.code).toBe('ALREADY_BOUND')
  })

  test('a non-gmail account never reaches the claim flow', async () => {
    await request(app)
      .post('/api/claim')
      .set(as('someone@sinarmas-agri.com', 'Someone'))
      .set('Idempotency-Key', randomUUID())
      .send({ memberId: pendingIds.Albert })
      .expect(403)
  })

  test('a synthetic QA session can never claim an identity', async () => {
    const qaId = `Q${randomUUID().replace(/-/g, '').toUpperCase().slice(0, 25)}`
    await upsertMember(roster, {
      memberId: qaId, email: '', displayName: 'QA claimer', role: 'member',
      status: 'active', isSynthetic: true,
    })
    // Synthetic members are excluded from the claimable list entirely.
    const res = await request(app)
      .get('/api/claim/options')
      .set(as(`another.${suffix}@gmail.com`, 'Nobody'))
      .expect(200)
    const ids = res.body.candidates.map((c: { memberId: string }) => c.memberId)
    expect(ids).not.toContain(qaId)
  })
})

describe('admin override corrects a wrong claim', () => {
  test('unlinking frees the address and preserves the member id', async () => {
    const email = `albert.wrong.${suffix}@gmail.com`
    await request(app)
      .post('/api/claim')
      .set(as(email, 'Albert'))
      .set('Idempotency-Key', randomUUID())
      .send({ memberId: pendingIds.Albert })
      .expect(200)

    await request(app)
      .post(`/api/admin/members/${pendingIds.Albert}/unlink-email`)
      .set(as(`claimadmin.${suffix}@gmail.com`, 'Claim Admin'))
      .set('Idempotency-Key', randomUUID())
      .expect(200)

    const member = await findMemberById(roster, pendingIds.Albert!)
    expect(member!.email).toBe('')
    expect(member!.memberId).toBe(pendingIds.Albert) // id survives, so the balance does
  })

  test('the freed address can be claimed again by the right person', async () => {
    const email = `albert.right.${suffix}@gmail.com`
    await request(app)
      .post('/api/claim')
      .set(as(email, 'Albert'))
      .set('Idempotency-Key', randomUUID())
      .send({ memberId: pendingIds.Albert })
      .expect(200)
    expect((await findMemberById(roster, pendingIds.Albert!))!.email).toBe(email)
  })

  test('the unlink is audited as an admin action', async () => {
    const entries = await listLinkAudit(roster)
    const unlink = entries.find((e) => e.action === 'unlink' && e.memberId === pendingIds.Albert)
    expect(unlink).toBeDefined()
    expect(unlink!.via).toBe('admin')
    expect(unlink!.actorMemberId).toBe(ADMIN_ID)
  })

  test('a member cannot unlink anyone', async () => {
    const res = await request(app)
      .post(`/api/admin/members/${pendingIds.Andri}/unlink-email`)
      .set(as(`roy.claimer.${suffix}@gmail.com`, 'Roy'))
      .set('Idempotency-Key', randomUUID())
      .expect(403)
    expect(res.body.error.code).toBe('ADMIN_REQUIRED')
  })
})
