import { describe, test, expect } from 'vitest'
import { resolveBasePath, BasePathError } from '../../basePath'

/**
 * The base path is now a build input, not a constant.
 *
 * The same source has to produce a GitHub Pages project site at
 * /coffee-sub-tracker/ and a Cloudflare Pages site at the root. Everything
 * downstream — manifest start_url and scope, icon URLs, the worker's scope and
 * navigation fallback, the recovery route — is derived from this one value, so
 * a malformed one is not a cosmetic problem: an empty string anchors a Workbox
 * navigateFallback pattern that matches far more than intended.
 *
 * It therefore validates loudly and never guesses.
 */
describe('resolveBasePath', () => {
  test('an unset or blank value means the site root', () => {
    // Root is the safe default: it is correct for `vite dev`, for `vite
    // preview` and for Cloudflare. A subpath host must say so explicitly.
    expect(resolveBasePath(undefined)).toBe('/')
    expect(resolveBasePath('')).toBe('/')
    expect(resolveBasePath('   ')).toBe('/')
    expect(resolveBasePath('/')).toBe('/')
  })

  test('a subpath is normalised to leading and trailing slashes', () => {
    for (const input of [
      '/coffee-sub-tracker/',
      'coffee-sub-tracker',
      '/coffee-sub-tracker',
      'coffee-sub-tracker/',
      '  /coffee-sub-tracker/  ',
    ]) {
      expect(resolveBasePath(input), input).toBe('/coffee-sub-tracker/')
    }
  })

  test('nested subpaths survive, and internal duplicate slashes collapse', () => {
    expect(resolveBasePath('a/b')).toBe('/a/b/')
    expect(resolveBasePath('a///b//')).toBe('/a/b/')
    expect(resolveBasePath('/a//b/')).toBe('/a/b/')
    // A *leading* '//' is not a duplicate slash, it is a protocol-relative URL,
    // and it stays refused — see the absolute-URL case below.
  })

  test('an absolute URL is refused rather than pasted into a path', () => {
    for (const input of [
      'https://coffee-sub.pages.dev/',
      'http://example.test/app/',
      '//evil.example/',
    ]) {
      expect(() => resolveBasePath(input), input).toThrow(BasePathError)
    }
  })

  test('traversal and query-shaped values are refused', () => {
    for (const input of ['/a/../b/', '..', '/app?x=1', '/app#frag', 'a\\b', '/a b/']) {
      expect(() => resolveBasePath(input), input).toThrow(BasePathError)
    }
  })

  test('the refusal says what was wrong with it', () => {
    expect(() => resolveBasePath('https://x.test/')).toThrow(/absolute/i)
    expect(() => resolveBasePath('/a/../b/')).toThrow(/\.\./)
  })
})
