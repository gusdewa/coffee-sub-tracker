/**
 * Configuration, resolved once at startup so a misconfigured deployment fails
 * loudly rather than at the first request.
 */
export interface Config {
  port: number
  firebaseProjectId: string
  allowedEmailDomain: string
  allowedOrigins: string[]
  storageAccountName: string | undefined
  undoWindowSeconds: number
  rosterCacheTtlMs: number
  isProduction: boolean
}

/**
 * Both hosts, for the duration of the migration. The Pages site stays until the
 * Cloudflare one is verified, so neither is a "previous" value yet.
 */
export const DEFAULT_ALLOWED_ORIGINS = [
  'https://gusdewa.github.io',
  'https://coffee-sub.pages.dev',
]

/**
 * Parse and validate the CORS allowlist.
 *
 * Fails loudly. A permissive fallback here is the difference between a
 * misconfigured deploy that refuses browsers and one that quietly accepts
 * every site on the internet.
 */
export function parseAllowedOrigins(raw: string): string[] {
  const entries = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')

  if (entries.length === 0) {
    throw new Error('ALLOWED_ORIGINS must list at least one origin')
  }

  const out: string[] = []
  for (const entry of entries) {
    if (entry === '*') {
      throw new Error('ALLOWED_ORIGINS must not contain a wildcard: bearer auth makes it unsafe')
    }
    let parsed: URL
    try {
      parsed = new URL(entry)
    } catch {
      throw new Error(`ALLOWED_ORIGINS entry is not a URL: "${entry}"`)
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(`ALLOWED_ORIGINS entry must be http(s): "${entry}"`)
    }
    // `origin` drops any path, so compare against the input to catch a value
    // that carries one — it would never match a browser-sent Origin header.
    if (parsed.origin !== entry) {
      throw new Error(
        `ALLOWED_ORIGINS entry must be a bare origin with no path or trailing slash: "${entry}"`,
      )
    }
    if (!out.includes(entry)) out.push(entry)
  }
  return out
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const isProduction = env.NODE_ENV === 'production'
  const cfg: Config = {
    port: Number(env.PORT ?? 8080),
    firebaseProjectId: env.FIREBASE_PROJECT_ID ?? 'coffee-sub-tracker-f4551d',
    allowedEmailDomain: env.ALLOWED_EMAIL_DOMAIN ?? 'gmail.com',
    // ALLOWED_ORIGINS is the plural form; ALLOWED_ORIGIN is still read so an
    // environment that has not been updated yet keeps working.
    allowedOrigins: parseAllowedOrigins(
      env.ALLOWED_ORIGINS ?? env.ALLOWED_ORIGIN ?? DEFAULT_ALLOWED_ORIGINS.join(','),
    ),
    storageAccountName: env.STORAGE_ACCOUNT_NAME,
    undoWindowSeconds: Number(env.UNDO_WINDOW_SECONDS ?? 90),
    rosterCacheTtlMs: Number(env.ROSTER_CACHE_TTL_MS ?? 60_000),
    isProduction,
  }

  if (isProduction && !cfg.storageAccountName) {
    throw new Error('STORAGE_ACCOUNT_NAME must be set in production')
  }
  return cfg
}
