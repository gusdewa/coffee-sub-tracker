/**
 * What went wrong signing in, said in the interface's own words.
 *
 * Only the cases this app's auth flow can actually produce are named. It uses
 * `signInWithPopup`, so there is no redirect return to handle — inventing a
 * state for it would mean writing UI nobody can ever reach. The popup's own
 * failure modes are the real list, and `auth/unauthorized-domain` is on it
 * because it is exactly what a move to a new host produces.
 */

export interface SignInFailure {
  message: string
  /**
   * Closing the popup yourself is not an error. It returns to ready and says
   * nothing, rather than accusing someone of a mistake they made on purpose.
   */
  silent: boolean
}

const codeOf = (error: unknown): string =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : ''

export function explainSignIn(error: unknown, offline: boolean): SignInFailure {
  // If the network is down, that is the cause whatever the SDK decided to call it.
  if (offline) {
    return { message: "You're offline. Sign-in needs a connection.", silent: false }
  }

  const code = codeOf(error)

  if (code.includes('popup-closed-by-user') || code.includes('cancelled-popup-request')) {
    return { message: '', silent: true }
  }
  if (code.includes('popup-blocked')) {
    return {
      message: 'Your browser blocked the Google pop-up. Allow pop-ups for this site and try again.',
      silent: false,
    }
  }
  if (code.includes('network-request-failed')) {
    return { message: 'No connection to Google. Check your network and try again.', silent: false }
  }
  if (code.includes('unauthorized-domain')) {
    return {
      message: 'This address is not approved for sign-in yet. Ask an admin to add it.',
      silent: false,
    }
  }
  if (code.includes('configuration-not-found') || code.includes('internal-error')) {
    return {
      message: 'Google sign-in is not switched on for this project yet. Ask an admin.',
      silent: false,
    }
  }
  if (code.includes('operation-not-supported-in-this-environment')) {
    return {
      message: 'This browser cannot open the Google window. Try opening the app in Chrome or Safari.',
      silent: false,
    }
  }
  return { message: 'Could not sign in. Please try again.', silent: false }
}
