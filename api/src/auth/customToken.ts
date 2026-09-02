import { SignJWT, importPKCS8, type KeyLike } from 'jose'

/**
 * Mint a Firebase custom token.
 *
 * A custom token is just an RS256 JWT signed by a Google service account with
 * a fixed audience, so it is produced here with `jose` rather than by pulling
 * in the whole Firebase Admin SDK. The client exchanges it via
 * `signInWithCustomToken` and then travels the *identical* path as a real
 * user — which is the point: QA exercises the production code path, and the
 * browser keeps exactly one auth mode.
 *
 * This is the only place in the service that needs a private key. It is read
 * from Key Vault through an App Service reference and never logged.
 */

const CUSTOM_TOKEN_AUDIENCE =
  'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit'

/** Firebase rejects custom tokens with a lifetime beyond one hour. */
const MAX_LIFETIME_SECONDS = 3600

export interface ServiceAccount {
  clientEmail: string
  privateKey: string
}

export class ServiceAccountUnavailableError extends Error {
  readonly code = 'QA_UNAVAILABLE'
  constructor() {
    super('QA sessions are not configured on this deployment')
    this.name = 'ServiceAccountUnavailableError'
  }
}

/**
 * Parse the service-account JSON supplied via `FIREBASE_SA_JSON`.
 * Returns undefined rather than throwing, so a deployment without QA
 * configured still starts and simply refuses QA redemption.
 */
export function loadServiceAccount(raw: string | undefined): ServiceAccount | undefined {
  if (!raw?.trim()) return undefined
  try {
    const parsed = JSON.parse(raw) as { client_email?: string; private_key?: string }
    if (!parsed.client_email || !parsed.private_key) return undefined
    return { clientEmail: parsed.client_email, privateKey: parsed.private_key }
  } catch {
    // Deliberately swallow the parse error: its message can contain fragments
    // of the key material.
    return undefined
  }
}

export interface MintOptions {
  uid: string
  claims?: Record<string, unknown>
  lifetimeSeconds?: number
  /** Injectable so tests can sign with a locally generated key. */
  signingKey?: KeyLike
  issuer?: string
}

export async function mintCustomToken(
  account: ServiceAccount | undefined,
  opts: MintOptions,
): Promise<string> {
  let key: KeyLike
  let issuer: string

  if (opts.signingKey) {
    key = opts.signingKey
    issuer = opts.issuer ?? 'test@example.iam.gserviceaccount.com'
  } else {
    if (!account) throw new ServiceAccountUnavailableError()
    key = await importPKCS8(account.privateKey, 'RS256')
    issuer = account.clientEmail
  }

  const lifetime = Math.min(opts.lifetimeSeconds ?? 3600, MAX_LIFETIME_SECONDS)
  const nowSec = Math.floor(Date.now() / 1000)

  return new SignJWT({ uid: opts.uid, claims: opts.claims ?? {} })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(issuer)
    .setSubject(issuer)
    .setAudience(CUSTOM_TOKEN_AUDIENCE)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + lifetime)
    .sign(key)
}

export { CUSTOM_TOKEN_AUDIENCE }
