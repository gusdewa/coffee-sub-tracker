import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const signInWithGoogle = vi.fn()
vi.mock('../../src/auth/firebase', () => ({
  signInWithGoogle: (...a: unknown[]) => signInWithGoogle(...a),
  signOut: vi.fn(),
}))

const { SignIn } = await import('../../src/screens/SignIn')
const { explainSignIn } = await import('../../src/auth/signInErrors')

const fbError = (code: string) => Object.assign(new Error(code), { code })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('the login screen', () => {
  test('says it is checking an existing session, and shows no sign-in button yet', () => {
    // No flash of a logged-out call to action while persistence is restoring —
    // the button would appear and then vanish under anyone already signed in.
    render(<SignIn restoring />)
    expect(screen.getByText(/checking your session/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /continue with google/i })).toBeNull()
  })

  test('offers one clear way in when it is ready', () => {
    render(<SignIn />)
    const cta = screen.getByRole('button', { name: /continue with google/i })
    expect(cta).toBeEnabled()
    expect(screen.getByRole('heading', { level: 1 })).toBeVisible()
  })

  test('says what is happening while the popup is open', async () => {
    let release: (v: unknown) => void = () => {}
    signInWithGoogle.mockImplementation(() => new Promise((res) => (release = res)))
    const user = userEvent.setup()
    render(<SignIn />)

    await user.click(screen.getByRole('button', { name: /continue with google/i }))
    const busy = await screen.findByRole('button', { name: /opening google/i })
    expect(busy).toBeDisabled()
    // A second tap must not open a second popup.
    await user.click(busy)
    expect(signInWithGoogle).toHaveBeenCalledTimes(1)
    release(null)
  })

  test('a cancelled popup returns to ready without shouting about it', async () => {
    signInWithGoogle.mockRejectedValue(fbError('auth/popup-closed-by-user'))
    const user = userEvent.setup()
    render(<SignIn />)
    await user.click(screen.getByRole('button', { name: /continue with google/i }))

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /continue with google/i })).toBeEnabled(),
    )
    // Closing the window yourself is not an error worth an alert.
    expect(screen.queryByRole('alert')).toBeNull()
  })

  test('a blocked popup explains the browser setting, inline and retryable', async () => {
    signInWithGoogle.mockRejectedValue(fbError('auth/popup-blocked'))
    const user = userEvent.setup()
    render(<SignIn />)
    await user.click(screen.getByRole('button', { name: /continue with google/i }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/pop-?up/i)
    // Inline and in normal flow, never a toast that disappears.
    expect(screen.getByRole('button', { name: /continue with google/i })).toBeEnabled()
  })

  test('offline is stated before the attempt, not after it fails', async () => {
    render(<SignIn offline />)
    expect(screen.getByRole('button', { name: /continue with google/i })).toBeDisabled()
    expect(screen.getByText(/you.re offline/i)).toBeInTheDocument()
  })

  test('an unexpected failure never shows a raw Firebase code', async () => {
    signInWithGoogle.mockRejectedValue(fbError('auth/something-we-did-not-anticipate'))
    const user = userEvent.setup()
    render(<SignIn />)
    await user.click(screen.getByRole('button', { name: /continue with google/i }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).not.toMatch(/auth\//)
    expect(alert.textContent).toBeTruthy()
  })
})

describe('sign-in failure copy', () => {
  test('names the cases the popup flow can actually produce', () => {
    expect(explainSignIn(fbError('auth/popup-closed-by-user'), false).silent).toBe(true)
    expect(explainSignIn(fbError('auth/cancelled-popup-request'), false).silent).toBe(true)
    expect(explainSignIn(fbError('auth/popup-blocked'), false).message).toMatch(/pop-?up/i)
    expect(explainSignIn(fbError('auth/network-request-failed'), false).message).toMatch(
      /connection|offline/i,
    )
    expect(explainSignIn(fbError('auth/unauthorized-domain'), false).message).toMatch(
      /address|domain/i,
    )
    expect(explainSignIn(fbError('auth/configuration-not-found'), false).message).toMatch(
      /not switched on/i,
    )
  })

  test('offline wins over whatever code the SDK produced', () => {
    expect(explainSignIn(fbError('auth/internal-error'), true).message).toMatch(/offline/i)
  })

  test('every explanation is a sentence, not a code', () => {
    for (const code of [
      'auth/popup-blocked',
      'auth/network-request-failed',
      'auth/unauthorized-domain',
      'auth/operation-not-supported-in-this-environment',
      'auth/totally-unknown',
    ]) {
      const { message } = explainSignIn(fbError(code), false)
      expect(message).not.toMatch(/auth\//)
      expect(message.endsWith('.')).toBe(true)
    }
  })
})
