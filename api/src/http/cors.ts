import type { Request, Response, NextFunction } from 'express'

/**
 * A single permitted origin — the GitHub Pages site. Bearer tokens carry the
 * credentials, so cookies are never used and `Allow-Credentials` stays off.
 */
export function cors(allowedOrigin: string) {
  return function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
    const origin = req.headers.origin
    if (origin === allowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key')
      res.setHeader('Access-Control-Max-Age', '86400')
    }
    if (req.method === 'OPTIONS') {
      res.status(origin === allowedOrigin ? 204 : 403).end()
      return
    }
    next()
  }
}
