/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FIREBASE_API_KEY: string
  readonly VITE_FIREBASE_AUTH_DOMAIN: string
  readonly VITE_FIREBASE_PROJECT_ID: string
  readonly VITE_FIREBASE_APP_ID: string
  readonly VITE_ALLOWED_EMAIL_DOMAIN: string
  readonly VITE_API_BASE_URL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** Injected at build time from GITHUB_SHA; 'dev' outside CI. */
declare const __APP_VERSION__: string
