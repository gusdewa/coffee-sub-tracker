import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose'

/**
 * Firebase ID token verification.
 *
 * Firebase ID tokens are RS256 JWTs signed by Google and verifiable against a
 * public JWKS, so **this path needs no secret at all** — no service-account
 * key, no Firebase Admin SDK. That is why the hot path of this service holds
 * no credentials beyond its managed identity.
 *
 * The `hd` (hosted domain) claim is deliberately NOT used as the domain gate:
 * Google does not reliably propagate it into Firebase ID tokens. The domain is
 * enforced from the verified email suffix in `authorize.ts`, backed by the
 * roster allowlist.
 */

const GOOGLE_JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'

export class UnauthenticatedError extends Error {
  readonly code = 'UNAUTHENTICATED'
  constructor(reason: string) {
    // The reason is for operators; the HTTP layer sends a generic message so
    // token internals are never echoed back to the caller.
    super(`Unauthenticated: ${reason}`)
    this.name = 'UnauthenticatedError'
  }
}

export interface VerifiedToken {
  uid: string
  email: string | undefined
  emailVerified: boolean
  displayName: string | undefined
  /** 'google.com' for real users, 'custom' for a redeemed QA session. */
  signInProvider: string
  /** True only for tokens minted by the QA redemption endpoint. */
  qa: boolean
  payload: JWTPayload
}

export interface VerifierOptions {
  projectId: string
  /** Overridable so tests can verify against a locally generated key set. */
  jwks?: JWTVerifyGetKey
  clockToleranceSec?: number
}

export type TokenVerifier = (token: string) => Promise<VerifiedToken>

export function createTokenVerifier(opts: VerifierOptions): TokenVerifier {
  const { projectId } = opts
  if (!projectId) throw new Error('FIREBASE_PROJECT_ID is not configured')

  const keys: JWTVerifyGetKey = opts.jwks ?? createRemoteJWKSet(new URL(GOOGLE_JWKS_URL))

  return async function verify(token: string): Promise<VerifiedToken> {
    if (!token) throw new UnauthenticatedError('missing token')

    let payload: JWTPayload
    try {
      const verified = await jwtVerify(token, keys, {
        issuer: `https://securetoken.google.com/${projectId}`,
        audience: projectId,
        algorithms: ['RS256'],
        clockTolerance: opts.clockToleranceSec ?? 5,
      })
      payload = verified.payload
    } catch (err) {
      throw new UnauthenticatedError((err as Error).message)
    }

    const uid = typeof payload.sub === 'string' ? payload.sub : ''
    if (!uid) throw new UnauthenticatedError('token has no subject')

    const firebase = (payload.firebase ?? {}) as { sign_in_provider?: unknown }
    const signInProvider =
      typeof firebase.sign_in_provider === 'string' ? firebase.sign_in_provider : 'unknown'

    return {
      uid,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      emailVerified: payload.email_verified === true,
      displayName: typeof payload.name === 'string' ? payload.name : undefined,
      signInProvider,
      qa: payload.qa === true,
      payload,
    }
  }
}
