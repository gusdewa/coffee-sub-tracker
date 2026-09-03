import { describe, test, expect, vi } from 'vitest'
import type { Request, Response, NextFunction } from 'express'
import { cors } from '../../src/http/cors.js'
import { parseAllowedOrigins } from '../../src/config.js'

/**
 * CORS during a host migration.
 *
 * The frontend is moving from GitHub Pages to Cloudflare Pages, and for a
 * while both origins are real. That makes the allowlist plural — which is
 * exactly when origin checking usually goes wrong, because `startsWith` and
 * `includes` both look like they work.
 *
 * Credentials travel as Firebase bearer tokens, never cookies, so
 * `Allow-Credentials` stays off and a wildcard is never acceptable: the API
 * would then be readable by any site a signed-in colleague happens to visit.
 */

const PAGES = 'https://gusdewa.github.io'
const CLOUDFLARE = 'https://coffee-sub.pages.dev'
const ALLOWED = [PAGES, CLOUDFLARE]

function run(origin: string | undefined, method = 'GET') {
  const headers: Record<string, string> = {}
  const res = {
    setHeader: (k: string, v: string) => {
      headers[k] = v
    },
    status: vi.fn(function (this: unknown) {
      return { end: endSpy }
    }),
  } as unknown as Response
  const endSpy = vi.fn()
  const next = vi.fn() as unknown as NextFunction
  const req = { method, headers: origin === undefined ? {} : { origin } } as unknown as Request

  cors(ALLOWED)(req, res, next)
  return { headers, next: next as unknown as ReturnType<typeof vi.fn>, status: res.status }
}

describe('the origin allowlist', () => {
  test('both migration origins are allowed, and each is reflected exactly', () => {
    for (const origin of ALLOWED) {
      const { headers } = run(origin)
      expect(headers['Access-Control-Allow-Origin']).toBe(origin)
      // Reflecting the whole list, or the wrong member of it, is not a match.
      expect(headers['Access-Control-Allow-Origin']).not.toContain(',')
    }
  })

  test('caches are told the answer depends on the origin', () => {
    expect(run(PAGES).headers['Vary']).toBe('Origin')
  })

  test('lookalikes are refused', () => {
    for (const origin of [
      'https://gusdewa.github.io.evil.test',
      'https://evilgusdewa.github.io',
      'https://coffee-sub.pages.dev.evil.test',
      'https://coffee-sub.pages.dev.',
      'http://gusdewa.github.io',
      'https://gusdewa.github.io:8443',
      'https://gusdewa.github.io/',
    ]) {
      const { headers } = run(origin)
      expect(headers['Access-Control-Allow-Origin'], origin).toBeUndefined()
    }
  })

  test('a subdomain of an allowed origin is still a different origin', () => {
    // Cloudflare gives every branch and every preview its own hostname.
    for (const origin of [
      'https://preview.coffee-sub.pages.dev',
      'https://abc123.coffee-sub.pages.dev',
    ]) {
      expect(run(origin).headers['Access-Control-Allow-Origin'], origin).toBeUndefined()
    }
  })

  test('the null origin is refused', () => {
    // Sandboxed iframes and file:// documents both send this.
    expect(run('null').headers['Access-Control-Allow-Origin']).toBeUndefined()
  })

  test('a request with no Origin is left alone and still served', () => {
    const { headers, next } = run(undefined)
    expect(headers['Access-Control-Allow-Origin']).toBeUndefined()
    expect(next).toHaveBeenCalled()
  })

  test('it never answers with a wildcard or offers credentials', () => {
    for (const origin of [...ALLOWED, 'https://evil.test', undefined]) {
      const { headers } = run(origin)
      expect(headers['Access-Control-Allow-Origin']).not.toBe('*')
      expect(headers['Access-Control-Allow-Credentials']).toBeUndefined()
    }
  })

  test('preflight succeeds for an allowed origin and is refused otherwise', () => {
    expect(run(CLOUDFLARE, 'OPTIONS').status).toHaveBeenCalledWith(204)
    expect(run('https://evil.test', 'OPTIONS').status).toHaveBeenCalledWith(403)
  })
})

describe('parseAllowedOrigins', () => {
  test('reads a comma-separated list, tolerating whitespace', () => {
    expect(parseAllowedOrigins(` ${PAGES} , ${CLOUDFLARE} `)).toEqual([PAGES, CLOUDFLARE])
  })

  test('accepts a single origin, which is what the old variable held', () => {
    expect(parseAllowedOrigins(PAGES)).toEqual([PAGES])
  })

  test('de-duplicates rather than reflecting the same origin twice', () => {
    expect(parseAllowedOrigins(`${PAGES},${PAGES}`)).toEqual([PAGES])
  })

  test('refuses a wildcard outright', () => {
    expect(() => parseAllowedOrigins('*')).toThrow(/wildcard/i)
    expect(() => parseAllowedOrigins(`${PAGES},*`)).toThrow(/wildcard/i)
  })

  test('refuses anything that is not a bare origin', () => {
    for (const bad of [
      'https://gusdewa.github.io/app',
      'https://gusdewa.github.io/',
      'gusdewa.github.io',
      'ftp://gusdewa.github.io',
      'not a url',
      'null',
    ]) {
      expect(() => parseAllowedOrigins(bad), bad).toThrow()
    }
  })

  test('refuses an empty list rather than defaulting to something permissive', () => {
    expect(() => parseAllowedOrigins('')).toThrow()
    expect(() => parseAllowedOrigins('  ,  ')).toThrow()
  })
})
