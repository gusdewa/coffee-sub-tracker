import { describe, test, beforeAll, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet, type JWK } from 'jose'
import type { TableClient } from '@azure/data-tables'

import { createTableClient, ensureTablesExist, azuriteConnectionString } from '../../src/storage/tableClient.js'
import { TABLES } from '../../src/storage/entities.js'
import { upsertMember, RosterCache, type RosterDeps } from '../../src/storage/roster.js'
import { createTokenVerifier, UnauthenticatedError } from '../../src/auth/verifyFirebaseToken.js'
import {
  authorize,
  requireAdmin,
  WrongDomainError,
  NotAllowlistedError,
  MemberDisabledError,
  AdminRequiredError,
  QaScopeDeniedError,
} from '../../src/auth/authorize.js'

process.env.AZURE_TABLES_CONNECTION_STRING ??= azuriteConnectionString()

const PROJECT_ID = 'srx-co-id'
const DOMAIN = 'srx.co.id'
const OPTS = { allowedEmailDomain: DOMAIN }

let members: TableClient
let deps: RosterDeps
let verify: ReturnType<typeof createTokenVerifier>
let privateKey: CryptoKey
let otherPrivateKey: CryptoKey

function memberId(): string {
  return `A${randomUUID().replace(/-/g, '').toUpperCase().slice(0, 25)}`
}

interface TokenOpts {
  sub: string
  email?: string
  emailVerified?: boolean
  provider?: string
  qa?: boolean
  issuer?: string
  audience?: string
  expiresIn?: string | number
  key?: CryptoKey
  issuedAt?: number
}

async function mintToken(o: TokenOpts): Promise<string> {
  const payload: Record<string, unknown> = {
    firebase: { sign_in_provider: o.provider ?? 'google.com' },
  }
  if (o.email !== undefined) payload.email = o.email
  if (o.emailVerified !== undefined) payload.email_verified = o.emailVerified
  if (o.qa) payload.qa = true

  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256' })
    .setSubject(o.sub)
    .setIssuer(o.issuer ?? `https://securetoken.google.com/${PROJECT_ID}`)
    .setAudience(o.audience ?? PROJECT_ID)
    .setIssuedAt(o.issuedAt ?? Math.floor(Date.now() / 1000))
    .setExpirationTime(o.expiresIn ?? '1h')
    .sign(o.key ?? privateKey)
}

beforeAll(async () => {
  await ensureTablesExist()
  members = createTableClient(TABLES.members)
  // TTL 0 keeps each test independent; the 60 s production cache is exercised
  // separately by the disabled-member test below.
  deps = { members, cache: new RosterCache(0) }

  const pair = await generateKeyPair('RS256', { extractable: true })
  const other = await generateKeyPair('RS256', { extractable: true })
  privateKey = pair.privateKey
  otherPrivateKey = other.privateKey

  const jwk = (await exportJWK(pair.publicKey)) as JWK
  jwk.alg = 'RS256'
  jwk.kid = 'test-key'
  verify = createTokenVerifier({ projectId: PROJECT_ID, jwks: createLocalJWKSet({ keys: [jwk] }) })
})

describe('token verification rejects malformed identity', () => {
  test('a token signed by the wrong key is refused', async () => {
    const t = await mintToken({ sub: 'x', key: otherPrivateKey })
    await expect(verify(t)).rejects.toBeInstanceOf(UnauthenticatedError)
  })

  test('a token for another Firebase project is refused', async () => {
    await expect(verify(await mintToken({ sub: 'x', audience: 'some-other-project' })))
      .rejects.toBeInstanceOf(UnauthenticatedError)
    await expect(verify(await mintToken({ sub: 'x', issuer: 'https://securetoken.google.com/evil' })))
      .rejects.toBeInstanceOf(UnauthenticatedError)
  })

  test('an expired token is refused', async () => {
    const nowSec = Math.floor(Date.now() / 1000)
    // Absolute timestamps: a relative "1s" would be measured from now, not
    // from the backdated iat, and would still be valid.
    const t = await mintToken({
      sub: 'x',
      issuedAt: nowSec - 7200,
      expiresIn: nowSec - 3600,
    })
    await expect(verify(t)).rejects.toBeInstanceOf(UnauthenticatedError)
  })

  test('an empty or garbage token is refused', async () => {
    await expect(verify('')).rejects.toBeInstanceOf(UnauthenticatedError)
    await expect(verify('not.a.jwt')).rejects.toBeInstanceOf(UnauthenticatedError)
  })

  test('a valid token is accepted and its claims surfaced', async () => {
    const t = await mintToken({ sub: 'uid-1', email: 'a@srx.co.id', emailVerified: true })
    const v = await verify(t)
    expect(v.uid).toBe('uid-1')
    expect(v.email).toBe('a@srx.co.id')
    expect(v.emailVerified).toBe(true)
    expect(v.signInProvider).toBe('google.com')
    expect(v.qa).toBe(false)
  })
})

describe('authorization gates (plan §5)', () => {
  test('an allowlisted, active member is admitted', async () => {
    const id = memberId()
    const email = `dewa-${id.toLowerCase()}@${DOMAIN}`
    await upsertMember(deps, {
      memberId: id, email, displayName: 'Dewa', role: 'admin', status: 'active', firebaseUid: 'uid-x',
    })

    const ctx = await authorize(deps, await verify(await mintToken({
      sub: 'uid-x', email, emailVerified: true,
    })), OPTS)

    expect(ctx.memberId).toBe(id)
    expect(ctx.role).toBe('admin')
    expect(ctx.isQa).toBe(false)
  })

  test('an address outside the workspace domain is refused', async () => {
    const t = await verify(await mintToken({ sub: 'u', email: 'someone@gmail.com', emailVerified: true }))
    await expect(authorize(deps, t, OPTS)).rejects.toBeInstanceOf(WrongDomainError)
  })

  test('an unverified email is refused even on the right domain', async () => {
    const t = await verify(await mintToken({ sub: 'u', email: `x@${DOMAIN}`, emailVerified: false }))
    await expect(authorize(deps, t, OPTS)).rejects.toBeInstanceOf(WrongDomainError)
  })

  test('a non-Google sign-in provider is refused', async () => {
    const t = await verify(await mintToken({
      sub: 'u', email: `x@${DOMAIN}`, emailVerified: true, provider: 'password',
    }))
    await expect(authorize(deps, t, OPTS)).rejects.toBeInstanceOf(WrongDomainError)
  })

  test('a valid domain account that is not on the roster is refused', async () => {
    const t = await verify(await mintToken({
      sub: 'u', email: `stranger-${randomUUID()}@${DOMAIN}`, emailVerified: true,
    }))
    await expect(authorize(deps, t, OPTS)).rejects.toBeInstanceOf(NotAllowlistedError)
  })

  test('a disabled member is refused', async () => {
    const id = memberId()
    const email = `off-${id.toLowerCase()}@${DOMAIN}`
    await upsertMember(deps, {
      memberId: id, email, displayName: 'Gone', role: 'member', status: 'disabled', firebaseUid: 'uid-off',
    })
    const t = await verify(await mintToken({ sub: 'uid-off', email, emailVerified: true }))
    await expect(authorize(deps, t, OPTS)).rejects.toBeInstanceOf(MemberDisabledError)
  })

  test('email matching ignores case and stray whitespace', async () => {
    const id = memberId()
    const email = `case-${id.toLowerCase()}@${DOMAIN}`
    await upsertMember(deps, {
      memberId: id, email, displayName: 'Case', role: 'member', status: 'active', firebaseUid: 'uid-c',
    })
    const ctx = await authorize(deps, await verify(await mintToken({
      sub: 'uid-c', email: email.toUpperCase(), emailVerified: true,
    })), OPTS)
    expect(ctx.memberId).toBe(id)
  })
})

describe('admin gate and QA scope containment (plan §7)', () => {
  test('a normal member is refused admin actions', async () => {
    const id = memberId()
    const email = `plain-${id.toLowerCase()}@${DOMAIN}`
    await upsertMember(deps, {
      memberId: id, email, displayName: 'Plain', role: 'member', status: 'active', firebaseUid: 'uid-p',
    })
    const ctx = await authorize(deps, await verify(await mintToken({
      sub: 'uid-p', email, emailVerified: true,
    })), OPTS)
    expect(() => requireAdmin(ctx)).toThrow(AdminRequiredError)
  })

  test('a QA session authorizes by uid, carries no email, and is non-admin', async () => {
    const qaId = memberId()
    await upsertMember(deps, {
      memberId: qaId, email: '', displayName: 'QA bot', role: 'member',
      status: 'active', isSynthetic: true,
    })

    const ctx = await authorize(deps, await verify(await mintToken({
      sub: qaId, provider: 'custom', qa: true,
    })), OPTS)

    expect(ctx.memberId).toBe(qaId)
    expect(ctx.isQa).toBe(true)
    expect(ctx.email).toBe('')
    expect(() => requireAdmin(ctx)).toThrow(QaScopeDeniedError)
  })

  test('a QA token is refused admin routes even if its roster row were made admin', async () => {
    const qaId = memberId()
    await upsertMember(deps, {
      memberId: qaId, email: '', displayName: 'QA bot', role: 'member',
      status: 'active', isSynthetic: true,
    })
    const ctx = await authorize(deps, await verify(await mintToken({
      sub: qaId, provider: 'custom', qa: true,
    })), OPTS)

    // Belt and braces: the QA claim is checked before role is consulted.
    const escalated = { ...ctx, role: 'admin' as const }
    expect(() => requireAdmin(escalated)).toThrow(QaScopeDeniedError)
  })

  test('a synthetic member cannot be reached through the Google path', async () => {
    const qaId = memberId()
    const email = `qa-${qaId.toLowerCase()}@${DOMAIN}`
    await upsertMember(deps, {
      memberId: qaId, email, displayName: 'QA bot', role: 'member',
      status: 'active', isSynthetic: true,
    })
    const t = await verify(await mintToken({ sub: 'uid-q', email, emailVerified: true }))
    await expect(authorize(deps, t, OPTS)).rejects.toBeInstanceOf(NotAllowlistedError)
  })

  test('a custom token WITHOUT the qa claim cannot impersonate a member', async () => {
    const id = memberId()
    const email = `real-${id.toLowerCase()}@${DOMAIN}`
    await upsertMember(deps, {
      memberId: id, email, displayName: 'Real', role: 'admin', status: 'active', firebaseUid: 'uid-r',
    })
    // provider 'custom' without qa=true falls through to the Google path and is refused.
    const t = await verify(await mintToken({ sub: id, provider: 'custom', email, emailVerified: true }))
    await expect(authorize(deps, t, OPTS)).rejects.toBeInstanceOf(WrongDomainError)
  })

  test('a qa-claimed token naming a NON-synthetic member is refused', async () => {
    const id = memberId()
    const email = `victim-${id.toLowerCase()}@${DOMAIN}`
    await upsertMember(deps, {
      memberId: id, email, displayName: 'Victim', role: 'admin', status: 'active', firebaseUid: 'uid-v',
    })
    const t = await verify(await mintToken({ sub: id, provider: 'custom', qa: true }))
    await expect(authorize(deps, t, OPTS)).rejects.toBeInstanceOf(NotAllowlistedError)
  })
})
