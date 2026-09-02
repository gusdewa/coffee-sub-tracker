import type { Request, Response, NextFunction } from 'express'
import { RateLimiterMemory } from 'rate-limiter-flexible'

/**
 * In-process token buckets. Correct for the single B3 instance this runs on;
 * scaling out would need a shared store, and the README says so rather than
 * leaving a silent correctness gap.
 *
 * The QA redemption limit is the security-relevant one: it is what turns a
 * 256-bit code from "practically unguessable" into "unguessable even with a
 * bot", and it is keyed by IP because redemption is unauthenticated.
 */

export interface Limiters {
  perMember: RateLimiterMemory
  drinks: RateLimiterMemory
  qaRedeem: RateLimiterMemory
}

export function createLimiters(): Limiters {
  return {
    perMember: new RateLimiterMemory({ points: 60, duration: 60 }),
    drinks: new RateLimiterMemory({ points: 10, duration: 60 }),
    qaRedeem: new RateLimiterMemory({ points: 5, duration: 60 }),
  }
}

export class RateLimitedError extends Error {
  readonly code = 'RATE_LIMITED'
  constructor(readonly retryAfterSeconds: number) {
    super('Too many requests, please slow down')
    this.name = 'RateLimitedError'
  }
}

export function limit(limiter: RateLimiterMemory, key: (req: Request) => string) {
  return async function rateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      await limiter.consume(key(req))
      next()
    } catch (rejection) {
      const ms = (rejection as { msBeforeNext?: number }).msBeforeNext ?? 60_000
      const seconds = Math.ceil(ms / 1000)
      res.setHeader('Retry-After', String(seconds))
      next(new RateLimitedError(seconds))
    }
  }
}

export const clientIp = (req: Request): string => req.ip ?? 'unknown'
