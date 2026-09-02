import { initializeApp, type FirebaseApp } from 'firebase/app'
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as fbSignOut,
  onIdTokenChanged,
  type Auth,
  type User,
} from 'firebase/auth'

/**
 * Firebase supplies identity and nothing else. The web config is public by
 * design — it names the project, it does not authorise anything. All authority
 * lives behind the API's token verification.
 *
 * Initialisation is lazy on purpose: eager setup at import time makes every
 * module that merely mentions the API client depend on live configuration,
 * which breaks tests and turns a missing env var into a blank page instead of
 * a message.
 */
let app: FirebaseApp | undefined
let authInstance: Auth | undefined

export function getAuthInstance(): Auth {
  if (!authInstance) {
    app ??= initializeApp({
      apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
      authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
      projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
      appId: import.meta.env.VITE_FIREBASE_APP_ID,
    })
    authInstance = getAuth(app)
  }
  return authInstance
}

export async function currentIdToken(): Promise<string> {
  const user = getAuthInstance().currentUser
  return user ? user.getIdToken() : ''
}

export function signInWithGoogle(): Promise<unknown> {
  const provider = new GoogleAuthProvider()
  // A hint for the account picker only. The domain is enforced server-side.
  const domain = import.meta.env.VITE_ALLOWED_EMAIL_DOMAIN
  if (domain) provider.setCustomParameters({ hd: domain })
  return signInWithPopup(getAuthInstance(), provider)
}

export const signOut = (): Promise<void> => fbSignOut(getAuthInstance())

export function watchUser(cb: (user: User | null) => void): () => void {
  return onIdTokenChanged(getAuthInstance(), cb)
}
