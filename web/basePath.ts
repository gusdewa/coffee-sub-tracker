/**
 * The one place a base path is decided.
 *
 * The same source ships to a GitHub Pages project site at /coffee-sub-tracker/
 * and to Cloudflare Pages at the root, and everything downstream is derived
 * from this value: Vite's `base`, the manifest's id, start_url, scope and icon
 * URLs, the service worker's scope and navigation fallback, the recovery
 * route, and the static server the e2e suite runs against.
 *
 * That makes a malformed value more than cosmetic. An empty string would
 * anchor `navigateFallback` at `index.html` with no path at all, and an
 * absolute URL pasted into a path produces a scope the worker silently refuses.
 * So this validates loudly, and an unset value means the root rather than
 * whichever host happened to be canonical when it was written.
 */

export class BasePathError extends Error {
  constructor(message: string) {
    super(`VITE_BASE_PATH: ${message}`)
    this.name = 'BasePathError'
  }
}

export function resolveBasePath(raw: string | undefined): string {
  const value = (raw ?? '').trim()
  if (value === '' || value === '/') return '/'

  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) {
    throw new BasePathError(`must be a path, not an absolute URL — got "${value}"`)
  }
  if (/[?#]/.test(value)) {
    throw new BasePathError(`must not contain a query or fragment — got "${value}"`)
  }
  if (/[\\\s]/.test(value)) {
    throw new BasePathError(`must not contain whitespace or backslashes — got "${value}"`)
  }

  const segments = value.split('/').filter((s) => s !== '')
  if (segments.some((s) => s === '.' || s === '..')) {
    throw new BasePathError(`must not contain "." or ".." segments — got "${value}"`)
  }

  return `/${segments.join('/')}/`
}
