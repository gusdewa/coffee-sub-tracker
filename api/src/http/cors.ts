import type { Request, Response, NextFunction } from 'express'

/**
 * An explicit allowlist of permitted origins.
 *
 * Plural because the frontend is migrating hosts and, for a while, both the
 * GitHub Pages site and the Cloudflare Pages site are real. Matching is exact
 * string equality against the browser-sent `Origin`: scheme, host and port all
 * have to agree, so a subdomain, a lookalike suffix and a different port are
 * all simply different origins. Cloudflare hands every preview branch its own
 * hostname, which makes that distinction load-bearing rather than pedantic.
 *
 * Bearer tokens carry the credentials, so cookies are never used,
 * `Allow-Credentials` stays off, and a wildcard is never an option — with one,
 * any site a signed-in colleague visited could read their balance.
 */
export function cors(allowedOrigins: readonly string[]) {
  const allowed = new Set(allowedOrigins)

  return function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
    const origin = req.headers.origin
    const permitted = typeof origin === 'string' && allowed.has(origin)

    if (permitted) {
      // Reflect the matched origin, never the whole list.
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key')
      res.setHeader('Access-Control-Max-Age', '86400')
    }

    if (req.method === 'OPTIONS') {
      res.status(permitted ? 204 : 403).end()
      return
    }
    next()
  }
}
