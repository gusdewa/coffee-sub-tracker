import express, { type NextFunction, type Request, type Response } from 'express'
import { randomUUID } from 'node:crypto'
import type { TableClient } from '@azure/data-tables'

import { loadConfig, type Config } from './config.js'
import { createTableClient } from './storage/tableClient.js'
import { TABLES } from './storage/entities.js'
import {
  RosterCache, listMembers, upsertMember, setMemberStatus,
  linkMemberEmail, unlinkMemberEmail, listLinkAudit, isPending,
} from './storage/roster.js'
import { createTokenVerifier, type TokenVerifier } from './auth/verifyFirebaseToken.js'
import {
  authorize, authorizeQaMember, requireAdmin, UnboundAccountError, type AuthContext,
} from './auth/authorize.js'
import { consumeOne } from './domain/consume.js'
import { undoConsume } from './domain/undo.js'
import { applyCorrection } from './domain/correction.js'
import { createBatch, reprovisionBatch, listBatches } from './domain/batches.js'
import {
  createQaLink, redeemQaLink, revokeQaLink, listQaLinks, resolveQaSession,
} from './domain/qaLinks.js'
import { getMyCoffee, getHistory, getAllBalances } from './domain/readModels.js'
import { predictMember } from './domain/predictMember.js'
import { sendError } from './http/errors.js'
import { cors } from './http/cors.js'
import { createLimiters, limit, clientIp } from './http/rateLimit.js'

/**
 * HTTP surface.
 *
 * The single most important rule in this file: on every non-admin route the
 * subject is `ctx.memberId`, derived from the verified token. A `memberId` in
 * a path or body is never read for those routes, so cross-user consumption is
 * impossible by construction rather than by a permission check that could be
 * forgotten on a new endpoint.
 */

export interface AppDeps {
  config?: Config
  ledger?: TableClient
  members?: TableClient
  batches?: TableClient
  qaSessions?: TableClient
  verifier?: TokenVerifier
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ctx?: AuthContext
      /** Set only on claim routes, for a verified account with no member yet. */
      unbound?: { email: string; googleDisplayName: string | undefined }
    }
  }
}

export function createApp(deps: AppDeps = {}) {
  const config = deps.config ?? loadConfig()
  const ledger = deps.ledger ?? createTableClient(TABLES.ledger)
  const members = deps.members ?? createTableClient(TABLES.members)
  const batches = deps.batches ?? createTableClient(TABLES.batches)
  const qaSessions = deps.qaSessions ?? createTableClient(TABLES.qaSessions)

  const cache = new RosterCache(config.rosterCacheTtlMs)
  const roster = { members, cache }
  const verifier =
    deps.verifier ?? createTokenVerifier({ projectId: config.firebaseProjectId })
  const limiters = createLimiters()

  const app = express()
  app.set('trust proxy', true)
  app.disable('x-powered-by')
  app.use(express.json({ limit: '16kb' }))
  app.use(cors(config.allowedOrigins))

  const asyncRoute =
    (fn: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) => {
      fn(req, res).catch(next)
    }

  /**
   * Middleware variant. asyncRoute is for terminal handlers that send a
   * response; middleware must hand control onward, or the request hangs.
   */
  const asyncMiddleware =
    (fn: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) => {
      fn(req, res).then(() => next()).catch(next)
    }

  /** Verify, authorize, and attach the context. Everything below trusts only this. */
  const authenticate = asyncMiddleware(async (req) => {
    const header = req.headers.authorization ?? ''

    // A QA session is an opaque server-issued token, resolved against storage
    // on every request — so revoking it takes effect immediately, and the path
    // works even before Firebase Identity Platform is initialised.
    if (header.startsWith('QA ')) {
      const qaMemberId = await resolveQaSession(
        { ...roster, qaSessions },
        header.slice(3).trim(),
      )
      req.ctx = await authorizeQaMember(roster, qaMemberId)
      return
    }

    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    const verified = await verifier(token)
    req.ctx = await authorize(roster, verified, { allowedEmailDomain: config.allowedEmailDomain })
  })

  /**
   * Claim routes accept a verified account that is not yet bound to a member.
   * The email always comes from the token — never from the request — so a
   * caller cannot claim on someone else's behalf.
   */
  const authenticateAllowUnbound = asyncMiddleware(async (req) => {
    const header = req.headers.authorization ?? ''
    if (header.startsWith('QA ')) {
      // A synthetic QA session is already bound and must never claim an identity.
      const qaMemberId = await resolveQaSession({ ...roster, qaSessions }, header.slice(3).trim())
      req.ctx = await authorizeQaMember(roster, qaMemberId)
      return
    }
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    const verified = await verifier(token)
    try {
      req.ctx = await authorize(roster, verified, { allowedEmailDomain: config.allowedEmailDomain })
    } catch (err) {
      if (err instanceof UnboundAccountError) {
        req.unbound = { email: err.email, googleDisplayName: err.googleDisplayName }
        return
      }
      throw err
    }
  })

  const withAuth = [
    authenticate,
    limit(limiters.perMember, (req) => req.ctx?.memberId ?? clientIp(req)),
  ]

  /** The client supplies the intent id; we validate its shape, never its origin. */
  const opIdOf = (req: Request): string => {
    const header = req.header('Idempotency-Key')
    return header && header.trim() ? header.trim() : randomUUID()
  }

  // --- public ---------------------------------------------------------------

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true })
  })

  app.post(
    '/api/qa/redeem',
    limit(limiters.qaRedeem, clientIp),
    asyncRoute(async (req, res) => {
      const code = String((req.body as { code?: unknown })?.code ?? '')
      const session = await redeemQaLink({ ...roster, qaSessions }, code)
      // The code is never echoed back, and never logged.
      res.json({
        sessionToken: session.sessionToken,
        qaMemberId: session.qaMemberId,
        expiresAt: session.expiresAt.toISOString(),
      })
    }),
  )

  // --- member ---------------------------------------------------------------

  app.get(
    '/api/me',
    withAuth,
    asyncRoute(async (req, res) => {
      const ctx = req.ctx!
      const coffee = await getMyCoffee({ ledger }, ctx.memberId)
      res.json({
        member: {
          memberId: ctx.memberId,
          displayName: ctx.displayName,
          role: ctx.role,
          isQa: ctx.isQa,
        },
        ...coffee,
      })
    }),
  )

  app.post(
    '/api/me/drinks',
    withAuth,
    limit(limiters.drinks, (req) => req.ctx?.memberId ?? clientIp(req)),
    asyncRoute(async (req, res) => {
      const ctx = req.ctx! // subject is the caller, never the body
      const result = await consumeOne({ ledger }, ctx.memberId, opIdOf(req))
      if (result.replayed) res.setHeader('Idempotency-Replayed', 'true')
      res.json(result)
    }),
  )

  app.post(
    '/api/me/drinks/:opId/undo',
    withAuth,
    asyncRoute(async (req, res) => {
      const ctx = req.ctx!
      const result = await undoConsume(
        { ledger },
        ctx.memberId,
        String(req.params.opId),
        opIdOf(req),
      )
      if (result.replayed) res.setHeader('Idempotency-Replayed', 'true')
      res.json(result)
    }),
  )

  app.get(
    '/api/me/history',
    withAuth,
    asyncRoute(async (req, res) => {
      const limitParam = Math.min(Number(req.query.limit ?? 50) || 50, 200)
      res.json({ items: await getHistory({ ledger }, req.ctx!.memberId, limitParam) })
    }),
  )

  app.get(
    '/api/balances',
    withAuth,
    asyncRoute(async (_req, res) => {
      // Display name and remaining total only — no email, no history.
      res.json({ balances: await getAllBalances({ ledger, ...roster }) })
    }),
  )

  app.get(
    '/api/batches',
    withAuth,
    asyncRoute(async (_req, res) => {
      const all = await listBatches({ ledger, batches })
      res.json({
        batches: all.map((b) => ({
          batchId: b.batchId,
          label: b.label,
          effectiveAt: b.effectiveAt.toISOString(),
          totalUnits: b.totalUnits,
          status: b.status,
        })),
      })
    }),
  )

  /**
   * Who could this account be? Returns the pending members plus a predicted
   * best match. The prediction is a convenience only — nothing binds here.
   */
  app.get(
    '/api/claim/options',
    authenticateAllowUnbound,
    asyncRoute(async (req, res) => {
      if (req.ctx) {
        res.json({ bound: true, member: { memberId: req.ctx.memberId, displayName: req.ctx.displayName } })
        return
      }
      const unbound = req.unbound!
      const pending = (await listMembers(roster))
        .filter((m) => !m.isSynthetic && m.status === 'active' && isPending(m))
        .map((m) => ({ memberId: m.memberId, displayName: m.displayName }))

      const prediction = predictMember(pending, unbound.googleDisplayName, unbound.email)
      res.json({ bound: false, candidates: pending, prediction })
    }),
  )

  /**
   * Bind the signed-in account to a pending member, immediately.
   *
   * The address is taken from the verified token, and uniqueness comes from the
   * index insert, so two people cannot claim the same identity and one person
   * cannot claim two. The audit records this as a self-claim, which is what
   * lets an admin review these separately and override a wrong one.
   */
  app.post(
    '/api/claim',
    authenticateAllowUnbound,
    limit(limiters.perMember, (req) => req.unbound?.email ?? req.ctx?.memberId ?? clientIp(req)),
    asyncRoute(async (req, res) => {
      if (req.ctx) {
        res.status(409).json({ error: { code: 'ALREADY_BOUND', message: 'That account is already linked' } })
        return
      }
      const unbound = req.unbound!
      const memberId = String((req.body as { memberId?: unknown })?.memberId ?? '')

      const target = (await listMembers(roster)).find((m) => m.memberId === memberId)
      if (!target || target.isSynthetic || target.status !== 'active' || !isPending(target)) {
        res.status(409).json({
          error: { code: 'NOT_CLAIMABLE', message: 'That member cannot be claimed' },
        })
        return
      }

      const member = await linkMemberEmail(roster, {
        actorMemberId: memberId, // the claimant acts as themselves
        memberId,
        email: unbound.email,
        opId: opIdOf(req),
        allowedDomain: config.allowedEmailDomain,
        via: 'self',
      })
      res.json({ memberId: member.memberId, displayName: member.displayName, bound: true })
    }),
  )

  // --- admin ----------------------------------------------------------------

  const adminOnly = asyncMiddleware(async (req) => {
    requireAdmin(req.ctx!)
  })

  app.get(
    '/api/admin/members',
    withAuth,
    adminOnly,
    asyncRoute(async (_req, res) => {
      const members = await listMembers(roster)
      res.json({
        members: members.map((m) => ({ ...m, pending: isPending(m) })),
      })
    }),
  )

  app.post(
    '/api/admin/members',
    withAuth,
    adminOnly,
    asyncRoute(async (req, res) => {
      const b = req.body as {
        memberId?: string
        email?: string
        displayName?: string
        role?: 'member' | 'admin'
        status?: 'active' | 'disabled'
      }
      await upsertMember(roster, {
        memberId: b.memberId ?? randomUUID().replace(/-/g, '').toUpperCase().slice(0, 26),
        // Omitted address => a pending member: known by name, unable to sign
        // in, and still eligible for allocations until someone links them.
        email: b.email ?? '',
        displayName: b.displayName ?? '',
        role: b.role ?? 'member',
        status: b.status ?? 'active',
      })
      res.status(201).json({ ok: true })
    }),
  )

  app.post(
    '/api/admin/members/:memberId/status',
    withAuth,
    adminOnly,
    asyncRoute(async (req, res) => {
      const status = (req.body as { status?: 'active' | 'disabled' }).status ?? 'active'
      await setMemberStatus(roster, String(req.params.memberId), status)
      res.json({ ok: true })
    }),
  )

  app.post(
    '/api/admin/members/:memberId/link-email',
    withAuth,
    adminOnly,
    asyncRoute(async (req, res) => {
      const email = String((req.body as { email?: unknown })?.email ?? '')
      const member = await linkMemberEmail(roster, {
        actorMemberId: req.ctx!.memberId,
        memberId: String(req.params.memberId),
        email,
        opId: opIdOf(req),
        allowedDomain: config.allowedEmailDomain,
      })
      res.json({ memberId: member.memberId, displayName: member.displayName, linked: true })
    }),
  )

  app.post(
    '/api/admin/members/:memberId/unlink-email',
    withAuth,
    adminOnly,
    asyncRoute(async (req, res) => {
      // The correction path for a self-claim that went to the wrong person.
      // The member keeps its id, so its balance and history survive intact.
      await unlinkMemberEmail(roster, {
        actorMemberId: req.ctx!.memberId,
        memberId: String(req.params.memberId),
        opId: opIdOf(req),
      })
      res.json({ ok: true, unlinked: true })
    }),
  )

  app.get(
    '/api/admin/link-audit',
    withAuth,
    adminOnly,
    asyncRoute(async (_req, res) => {
      res.json({ entries: await listLinkAudit(roster) })
    }),
  )

  app.post(
    '/api/admin/members/:memberId/corrections',
    withAuth,
    adminOnly,
    asyncRoute(async (req, res) => {
      const b = req.body as { delta?: number; reason?: string }
      const result = await applyCorrection(
        { ledger },
        req.ctx!.memberId,
        String(req.params.memberId),
        Number(b.delta),
        String(b.reason ?? ''),
        opIdOf(req),
      )
      res.json(result)
    }),
  )

  app.get(
    '/api/admin/members/:memberId/history',
    withAuth,
    adminOnly,
    asyncRoute(async (req, res) => {
      res.json({ items: await getHistory({ ledger }, String(req.params.memberId)) })
    }),
  )

  app.post(
    '/api/admin/batches',
    withAuth,
    adminOnly,
    asyncRoute(async (req, res) => {
      const b = req.body as {
        label?: string
        effectiveAt?: string
        allocations?: Array<{ memberId: string; units: number }>
      }
      const batch = await createBatch({ ledger, batches }, req.ctx!.memberId, {
        label: String(b.label ?? ''),
        ...(b.effectiveAt ? { effectiveAt: new Date(b.effectiveAt) } : {}),
        allocations: b.allocations ?? [],
      })
      res.status(201).json(batch)
    }),
  )

  app.post(
    '/api/admin/batches/:batchId/reprovision',
    withAuth,
    adminOnly,
    asyncRoute(async (req, res) => {
      const b = req.body as { allocations?: Array<{ memberId: string; units: number }> }
      const batch = await reprovisionBatch(
        { ledger, batches },
        req.ctx!.memberId,
        String(req.params.batchId),
        b.allocations ?? [],
      )
      res.json(batch)
    }),
  )

  app.post(
    '/api/admin/qa-links',
    withAuth,
    adminOnly,
    asyncRoute(async (req, res) => {
      const b = req.body as { ttlMinutes?: number; maxUses?: number; label?: string }
      const link = await createQaLink({ ...roster, qaSessions }, req.ctx!.memberId, {
        ...(b.ttlMinutes ? { ttlMinutes: b.ttlMinutes } : {}),
        ...(b.maxUses ? { maxUses: b.maxUses } : {}),
        ...(b.label ? { label: b.label } : {}),
      })
      // The only time the plaintext code is ever emitted.
      res.status(201).json({
        linkId: link.linkId,
        code: link.code,
        qaMemberId: link.qaMemberId,
        expiresAt: link.expiresAt.toISOString(),
      })
    }),
  )

  app.get(
    '/api/admin/qa-links',
    withAuth,
    adminOnly,
    asyncRoute(async (_req, res) => {
      res.json({ links: await listQaLinks({ ...roster, qaSessions }) })
    }),
  )

  app.delete(
    '/api/admin/qa-links/:linkId',
    withAuth,
    adminOnly,
    asyncRoute(async (req, res) => {
      await revokeQaLink({ ...roster, qaSessions }, String(req.params.linkId))
      res.json({ ok: true })
    }),
  )

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such endpoint' } })
  })

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    sendError(res, err)
  })

  return app
}
