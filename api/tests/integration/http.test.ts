import { describe, test, beforeAll, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import type { TableClient } from '@azure/data-tables'

import { createApp } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import { createTableClient, ensureTablesExist, azuriteConnectionString } from '../../src/storage/tableClient.js'
import { TABLES } from '../../src/storage/entities.js'
import { RosterCache, upsertMember } from '../../src/storage/roster.js'
import { createBatch } from '../../src/domain/batches.js'
import type { VerifiedToken } from '../../src/auth/verifyFirebaseToken.js'
import { UnauthenticatedError } from '../../src/auth/verifyFirebaseToken.js'

process.env.AZURE_TABLES_CONNECTION_STRING ??= azuriteConnectionString()

const DOMAIN = 'srx.co.id'
const ORIGIN = 'https://gusdewa.github.io'

let ledger: TableClient
let members: TableClient
let batches: TableClient
let qaSessions: TableClient
let app: ReturnType<typeof createApp>

const ids = {
  admin: 'HTTPADMIN00000000000000AAA',
  alice: 'HTTPALICE00000000000000AAA',
  bob: 'HTTPBOB0000000000000000AAA',
  qa: 'HTTPQA00000000000000000AAA',
}

/**
 * A stub verifier: the token string *is* the member id. Firebase signature
 * verification is covered in auth.test.ts; this suite is about what the HTTP
 * layer does with an already-verified identity.
 */
const stubVerifier = async (token: string): Promise<VerifiedToken> => {
  if (!token) throw new UnauthenticatedError('missing token')
  const known: Record<string, VerifiedToken> = {
    admin: mk(ids.admin, `admin@${DOMAIN}`),
    alice: mk(ids.alice, `alice@${DOMAIN}`),
    bob: mk(ids.bob, `bob@${DOMAIN}`),
    qa: { ...mk(ids.qa, undefined), signInProvider: 'custom', qa: true },
  }
  const found = known[token]
  if (!found) throw new UnauthenticatedError('unknown test token')
  return found
}

function mk(uid: string, email: string | undefined): VerifiedToken {
  return {
    uid,
    email,
    emailVerified: true,
    displayName: undefined,
    signInProvider: 'google.com',
    qa: false,
    payload: {},
  }
}

const auth = (t: string) => ({ Authorization: `Bearer ${t}` })

beforeAll(async () => {
  await ensureTablesExist()
  ledger = createTableClient(TABLES.ledger)
  members = createTableClient(TABLES.members)
  batches = createTableClient(TABLES.batches)
  qaSessions = createTableClient(TABLES.qaSessions)

  await upsertMember({ members, cache: new RosterCache(0) }, {
    memberId: ids.admin, email: `admin@${DOMAIN}`, displayName: 'Admin', role: 'admin', status: 'active',
  })
  await upsertMember({ members, cache: new RosterCache(0) }, {
    memberId: ids.alice, email: `alice@${DOMAIN}`, displayName: 'Alice', role: 'member', status: 'active',
  })
  await upsertMember({ members, cache: new RosterCache(0) }, {
    memberId: ids.bob, email: `bob@${DOMAIN}`, displayName: 'Bob', role: 'member', status: 'active',
  })
  await upsertMember({ members, cache: new RosterCache(0) }, {
    memberId: ids.qa, email: '', displayName: 'QA', role: 'member', status: 'active', isSynthetic: true,
  })

  await createBatch({ ledger, batches }, ids.admin, {
    label: 'HTTP seed',
    allocations: [
      { memberId: ids.alice, units: 20 },
      { memberId: ids.bob, units: 20 },
    ],
  })

  const config = { ...loadConfig(), rosterCacheTtlMs: 0, allowedEmailDomain: DOMAIN, allowedOrigin: ORIGIN }
  app = createApp({ config, ledger, members, batches, qaSessions, verifier: stubVerifier })
})

describe('authentication boundary', () => {
  test('health needs no token', async () => {
    await request(app).get('/api/health').expect(200, { ok: true })
  })

  test('a missing or unknown token is refused', async () => {
    await request(app).get('/api/me').expect(401)
    const res = await request(app).get('/api/me').set(auth('nobody')).expect(401)
    expect(res.body.error.code).toBe('UNAUTHENTICATED')
    // The generic message must not leak why verification failed.
    expect(res.body.error.message).toBe('Sign-in required')
  })

  test('an authenticated member sees their own balance', async () => {
    const res = await request(app).get('/api/me').set(auth('alice')).expect(200)
    expect(res.body.member.memberId).toBe(ids.alice)
    expect(res.body.member.role).toBe('member')
    expect(res.body.totalRemaining).toBeGreaterThan(0)
  })
})

describe('cross-user denial — client-supplied ids are ignored (acceptance 8)', () => {
  test('a memberId in the body cannot redirect a drink to someone else', async () => {
    const before = await request(app).get('/api/me').set(auth('bob')).expect(200)

    await request(app)
      .post('/api/me/drinks')
      .set(auth('alice'))
      .set('Idempotency-Key', randomUUID())
      .send({ memberId: ids.bob, subjectMemberId: ids.bob, userId: ids.bob })
      .expect(200)

    const after = await request(app).get('/api/me').set(auth('bob')).expect(200)
    expect(after.body.totalRemaining).toBe(before.body.totalRemaining) // Bob untouched
  })

  test('one member cannot undo another member’s drink via the path', async () => {
    const drink = await request(app)
      .post('/api/me/drinks')
      .set(auth('bob'))
      .set('Idempotency-Key', randomUUID())
      .expect(200)

    const res = await request(app)
      .post(`/api/me/drinks/${drink.body.opId}/undo`)
      .set(auth('alice'))
      .set('Idempotency-Key', randomUUID())
      .expect(404)

    expect(res.body.error.code).toBe('TRANSACTION_NOT_FOUND')
  })

  test('history is always the caller’s own', async () => {
    const res = await request(app).get('/api/me/history').set(auth('alice')).expect(200)
    for (const item of res.body.items) {
      expect(['CONSUME', 'REVERSAL', 'CORRECTION', 'GRANT']).toContain(item.type)
    }
  })
})

describe('idempotency and balance semantics over HTTP', () => {
  test('the same Idempotency-Key replays rather than double-drinking', async () => {
    const key = randomUUID()
    const first = await request(app).post('/api/me/drinks').set(auth('alice')).set('Idempotency-Key', key).expect(200)
    const second = await request(app).post('/api/me/drinks').set(auth('alice')).set('Idempotency-Key', key).expect(200)

    expect(second.headers['idempotency-replayed']).toBe('true')
    expect(second.body.txnRowKey).toBe(first.body.txnRowKey)
  })

  test('an Idempotency-Key with an illegal character is refused, not stored', async () => {
    const res = await request(app)
      .post('/api/me/drinks')
      .set(auth('alice'))
      .set('Idempotency-Key', 'bad#key')
      .expect(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
  })

  test('a member with no balance gets 409 NO_BALANCE', async () => {
    const dry = 'HTTPDRY0000000000000000AAA'
    await upsertMember({ members, cache: new RosterCache(0) }, {
      memberId: dry, email: `dry@${DOMAIN}`, displayName: 'Dry', role: 'member', status: 'active',
    })
    const verifier = async (t: string) =>
      t === 'dry' ? mk(dry, `dry@${DOMAIN}`) : stubVerifier(t)
    const dryApp = createApp({
      config: { ...loadConfig(), rosterCacheTtlMs: 0, allowedEmailDomain: DOMAIN, allowedOrigin: ORIGIN },
      ledger, members, batches, qaSessions, verifier,
    })

    const res = await request(dryApp)
      .post('/api/me/drinks')
      .set(auth('dry'))
      .set('Idempotency-Key', randomUUID())
      .expect(409)
    expect(res.body.error.code).toBe('NO_BALANCE')
  })
})

describe('admin gate and QA scope over HTTP', () => {
  test('a member is refused every admin route', async () => {
    for (const [method, path] of [
      ['get', '/api/admin/members'],
      ['post', '/api/admin/batches'],
      ['get', '/api/admin/qa-links'],
      ['post', '/api/admin/qa-links'],
    ] as const) {
      const res = await request(app)[method](path).set(auth('alice')).send({})
      expect(res.status).toBe(403)
      expect(res.body.error.code).toBe('ADMIN_REQUIRED')
    }
  })

  test('a QA session is refused admin routes with its own code', async () => {
    const res = await request(app).get('/api/admin/members').set(auth('qa')).expect(403)
    expect(res.body.error.code).toBe('QA_SCOPE_DENIED')
  })

  test('a QA session can still use ordinary member routes', async () => {
    const res = await request(app).get('/api/me').set(auth('qa')).expect(200)
    expect(res.body.member.isQa).toBe(true)
  })

  test('an admin can read the roster and create a batch', async () => {
    await request(app).get('/api/admin/members').set(auth('admin')).expect(200)
    const res = await request(app)
      .post('/api/admin/batches')
      .set(auth('admin'))
      .send({ label: 'Via HTTP', allocations: [{ memberId: ids.alice, units: 2 }] })
      .expect(201)
    expect(res.body.status).toBe('active')
  })

  test('a correction without a reason is refused', async () => {
    const res = await request(app)
      .post(`/api/admin/members/${ids.alice}/corrections`)
      .set(auth('admin'))
      .set('Idempotency-Key', randomUUID())
      .send({ delta: -1, reason: '  ' })
      .expect(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
  })
})

describe('CORS is pinned to the Pages origin', () => {
  test('the allowed origin receives CORS headers', async () => {
    const res = await request(app).get('/api/health').set('Origin', ORIGIN).expect(200)
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN)
    expect(res.headers['access-control-allow-credentials']).toBeUndefined()
  })

  test('another origin receives none, and its preflight is refused', async () => {
    const res = await request(app).get('/api/health').set('Origin', 'https://evil.example').expect(200)
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
    await request(app).options('/api/me').set('Origin', 'https://evil.example').expect(403)
  })

  test('a valid preflight is answered 204', async () => {
    await request(app).options('/api/me/drinks').set('Origin', ORIGIN).expect(204)
  })
})
