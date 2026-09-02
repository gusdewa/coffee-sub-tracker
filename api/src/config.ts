/**
 * Configuration, resolved once at startup so a misconfigured deployment fails
 * loudly rather than at the first request.
 */
export interface Config {
  port: number
  firebaseProjectId: string
  allowedEmailDomain: string
  allowedOrigin: string
  storageAccountName: string | undefined
  undoWindowSeconds: number
  rosterCacheTtlMs: number
  /** Service-account JSON for QA custom tokens; absent disables QA only. */
  firebaseServiceAccountJson: string | undefined
  isProduction: boolean
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const isProduction = env.NODE_ENV === 'production'
  const cfg: Config = {
    port: Number(env.PORT ?? 8080),
    firebaseProjectId: env.FIREBASE_PROJECT_ID ?? 'srx-co-id',
    allowedEmailDomain: env.ALLOWED_EMAIL_DOMAIN ?? 'gmail.com',
    allowedOrigin: env.ALLOWED_ORIGIN ?? 'https://gusdewa.github.io',
    storageAccountName: env.STORAGE_ACCOUNT_NAME,
    undoWindowSeconds: Number(env.UNDO_WINDOW_SECONDS ?? 90),
    rosterCacheTtlMs: Number(env.ROSTER_CACHE_TTL_MS ?? 60_000),
    firebaseServiceAccountJson: env.FIREBASE_SA_JSON,
    isProduction,
  }

  if (isProduction && !cfg.storageAccountName) {
    throw new Error('STORAGE_ACCOUNT_NAME must be set in production')
  }
  return cfg
}
