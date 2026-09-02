import type { VerifiedToken } from './verifyFirebaseToken.js'
import { findMemberById, findMemberByEmail, type Member, type RosterDeps } from '../storage/roster.js'

/**
 * Turn a verified identity into an authorization decision.
 *
 * Order matters, and every step fails closed. Identity alone grants nothing:
 * a perfectly valid Google token for an unlisted address is refused, and a
 * disabled member is refused within one cache TTL regardless of how fresh
 * their token is.
 */

export class WrongDomainError extends Error {
  readonly code = 'WRONG_DOMAIN'
  constructor() {
    super('That Google account is outside the permitted workspace domain')
    this.name = 'WrongDomainError'
  }
}

export class NotAllowlistedError extends Error {
  readonly code = 'NOT_ALLOWLISTED'
  constructor() {
    super('That account is not on the coffee roster')
    this.name = 'NotAllowlistedError'
  }
}

export class MemberDisabledError extends Error {
  readonly code = 'MEMBER_DISABLED'
  constructor() {
    super('That member is disabled')
    this.name = 'MemberDisabledError'
  }
}

export class AdminRequiredError extends Error {
  readonly code = 'ADMIN_REQUIRED'
  constructor() {
    super('That action requires an admin')
    this.name = 'AdminRequiredError'
  }
}

export class QaScopeDeniedError extends Error {
  readonly code = 'QA_SCOPE_DENIED'
  constructor() {
    super('QA sessions may not use admin endpoints')
    this.name = 'QaScopeDeniedError'
  }
}

export interface AuthContext {
  memberId: string
  email: string
  displayName: string
  role: Member['role']
  isQa: boolean
}

export interface AuthorizeOptions {
  allowedEmailDomain: string
}

/**
 * Admit a QA session. It never carries an email and never touches the Google
 * path; the member it names must be synthetic and non-admin.
 */
export async function authorizeQaMember(
  deps: RosterDeps,
  qaMemberId: string,
): Promise<AuthContext> {
  const member = await findMemberById(deps, qaMemberId)
  if (!member) throw new NotAllowlistedError()
  if (!member.isSynthetic) throw new NotAllowlistedError()
  if (member.role !== 'member') throw new NotAllowlistedError()
  if (member.status !== 'active') throw new MemberDisabledError()

  return {
    memberId: member.memberId,
    email: '',
    displayName: member.displayName,
    role: 'member',
    isQa: true,
  }
}

export async function authorize(
  deps: RosterDeps,
  token: VerifiedToken,
  opts: AuthorizeOptions,
): Promise<AuthContext> {
  const member = token.qa
    ? await authorizeQaSession(deps, token)
    : await authorizeGoogleUser(deps, token, opts)

  if (member.status !== 'active') throw new MemberDisabledError()

  return {
    memberId: member.memberId,
    email: member.email,
    displayName: member.displayName || token.displayName || member.email,
    role: member.role,
    isQa: token.qa,
  }
}

/**
 * Members are identified by a **personal Google account**. A member whose
 * address has not been confirmed has no email index row, so this lookup simply
 * fails — a pending member cannot sign in, and no address is ever inferred
 * from a corporate alias.
 */
async function authorizeGoogleUser(
  deps: RosterDeps,
  token: VerifiedToken,
  opts: AuthorizeOptions,
): Promise<Member> {
  // A Google-issued, verified address is the only accepted identity shape.
  if (token.signInProvider !== 'google.com') throw new WrongDomainError()
  if (!token.emailVerified || !token.email) throw new WrongDomainError()

  const suffix = `@${opts.allowedEmailDomain.toLowerCase()}`
  if (!token.email.toLowerCase().endsWith(suffix)) throw new WrongDomainError()

  const member = await findMemberByEmail(deps, token.email)
  if (!member) throw new NotAllowlistedError()
  // A synthetic QA member must never be reachable through the Google path.
  if (member.isSynthetic) throw new NotAllowlistedError()
  return member
}

/**
 * QA sessions carry no email by design — nothing is invented, no real-domain
 * identity is fabricated. The uid *is* the synthetic member id, and the row it
 * names must be synthetic and non-admin.
 */
async function authorizeQaSession(deps: RosterDeps, token: VerifiedToken): Promise<Member> {
  if (token.signInProvider !== 'custom') throw new NotAllowlistedError()

  const member = await findMemberById(deps, token.uid)
  if (!member) throw new NotAllowlistedError()
  if (!member.isSynthetic) throw new NotAllowlistedError()
  if (member.role !== 'member') throw new NotAllowlistedError()
  return member
}

/**
 * Admin gate. A QA session is refused before role is even considered, so a
 * misconfigured synthetic member still cannot reach an admin endpoint.
 */
export function requireAdmin(ctx: AuthContext): void {
  if (ctx.isQa) throw new QaScopeDeniedError()
  if (ctx.role !== 'admin') throw new AdminRequiredError()
}
