import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../../src/auth/firebase', () => ({ currentIdToken: vi.fn().mockResolvedValue(null) }))

const fetchCall = vi.fn()
vi.stubGlobal('fetch', fetchCall)

const { api, ApiError, OfflineError, TimeoutError } = await import('../../src/api/client')
const { currentIdToken } = await import('../../src/auth/firebase')
const { resetMutationGuard } = await import('../../src/pwa/mutationGuard')

const ok = (body: unknown = { balances: [], items: [] }) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

/**
 * Behaves like a real fetch whose server never answers: it stays pending until
 * its signal aborts, then rejects with the DOMException a browser would throw.
 * request() turns that rejection into OfflineError, which is exactly the
 * misreport the read timeout must not make.
 */
const hangingFetch = (_url: string, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener(
      'abort',
      () => reject(new DOMException('The operation was aborted.', 'AbortError')),
      { once: true },
    )
  })

/** Records how a promise settled without awaiting it, so fake time can advance. */
function track(promise: Promise<unknown>) {
  const seen: { settled: boolean; error?: unknown } = { settled: false }
  promise.then(
    () => {
      seen.settled = true
    },
    (error: unknown) => {
      seen.settled = true
      seen.error = error
    },
  )
  return seen
}

const fetchInit = (call = 0) => fetchCall.mock.calls[call]?.[1] as RequestInit | undefined
const fetchUrl = (call = 0) => fetchCall.mock.calls[call]?.[0] as string | undefined

beforeEach(() => {
  fetchCall.mockReset()
  // A fresh Response per call: a body can only be read once.
  fetchCall.mockImplementation(() => Promise.resolve(ok()))
})

afterEach(() => {
  vi.useRealTimers()
  resetMutationGuard()
})

describe('API reads', () => {
  test.each([
    ['the member balance', () => api.me()],
    ['the team recap balances', () => api.balances()],
    ['the team recap balances under a deadline', () => api.balances({ timeoutMs: 5_000 })],
    ['the history', () => api.history()],
    ['a longer history under a deadline', () => api.history(100, { timeoutMs: 8_000 })],
  ])('does not allow browser caching for %s', async (_label, request) => {
    await request()

    expect(fetchCall).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cache: 'no-store' }),
    )
  })

  test('history(100) asks for a hundred items and history() keeps the bare path', async () => {
    await api.history(100)
    await api.history()

    expect(fetchUrl(0)).toMatch(/\/api\/me\/history\?limit=100$/)
    expect(fetchUrl(1)).toMatch(/\/api\/me\/history$/)
  })

  test.each([
    ['me()', () => api.me()],
    ['history()', () => api.history()],
    ['balances()', () => api.balances()],
  ])('%s without options keeps its old shape: no signal, no timer', async (_label, request) => {
    vi.useFakeTimers()
    fetchCall.mockImplementation(hangingFetch)

    const seen = track(request())
    await vi.advanceTimersByTimeAsync(0)

    expect(fetchInit()).not.toHaveProperty('signal')
    expect(vi.getTimerCount()).toBe(0)
    expect(seen.settled).toBe(false)
  })
})

describe('read deadlines', () => {
  test('a read that outlives its deadline fails as TimeoutError, not OfflineError', async () => {
    vi.useFakeTimers()
    fetchCall.mockImplementation(hangingFetch)

    const seen = track(api.balances({ timeoutMs: 5_000 }))

    await vi.advanceTimersByTimeAsync(4_999)
    expect(seen.settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    expect(seen.error).toBeInstanceOf(TimeoutError)
    expect(seen.error).not.toBeInstanceOf(OfflineError)
    expect(seen.error).toMatchObject({ name: 'TimeoutError', code: 'TIMEOUT' })
    // The socket is released, not left to answer into nothing.
    expect(fetchInit()?.signal?.aborted).toBe(true)
  })

  test('the deadline covers a token refresh that never answers', async () => {
    vi.useFakeTimers()
    // The clock must start before currentIdToken(): a wedged Firebase refresh
    // would otherwise hang the read before fetch ever sees a signal.
    vi.mocked(currentIdToken).mockReturnValueOnce(new Promise<string>(() => {}))

    const seen = track(api.history(100, { timeoutMs: 8_000 }))

    await vi.advanceTimersByTimeAsync(8_000)
    expect(seen.error).toBeInstanceOf(TimeoutError)
    expect(fetchCall).not.toHaveBeenCalled()
  })

  test('a caller abort surfaces as AbortError, not OfflineError', async () => {
    fetchCall.mockImplementation(hangingFetch)
    const controller = new AbortController()

    const seen = track(api.balances({ timeoutMs: 5_000, signal: controller.signal }))
    await vi.waitFor(() => expect(fetchCall).toHaveBeenCalledTimes(1))
    controller.abort()

    await vi.waitFor(() => expect(seen.settled).toBe(true))
    expect(seen.error).toBeInstanceOf(DOMException)
    expect(seen.error).toMatchObject({ name: 'AbortError' })
    expect(seen.error).not.toBeInstanceOf(OfflineError)
    expect(seen.error).not.toBeInstanceOf(TimeoutError)
    expect(fetchInit()?.signal?.aborted).toBe(true)
  })

  test('a caller abort also ends a read still waiting on the token', async () => {
    vi.mocked(currentIdToken).mockReturnValueOnce(new Promise<string>(() => {}))
    const controller = new AbortController()

    const seen = track(api.balances({ signal: controller.signal }))
    controller.abort()

    await vi.waitFor(() => expect(seen.settled).toBe(true))
    expect(seen.error).toMatchObject({ name: 'AbortError' })
    expect(fetchCall).not.toHaveBeenCalled()
  })

  test('an already-aborted signal never reaches the network', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(api.history(100, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(fetchCall).not.toHaveBeenCalled()
  })

  test('a dropped connection under a deadline is still OfflineError', async () => {
    vi.useFakeTimers()
    fetchCall.mockRejectedValueOnce(new TypeError('Failed to fetch'))

    const seen = track(api.balances({ timeoutMs: 5_000 }))
    await vi.advanceTimersByTimeAsync(0)

    expect(seen.error).toBeInstanceOf(OfflineError)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('the timer is cleared once a read answers', async () => {
    vi.useFakeTimers()

    const seen = track(api.history(100, { timeoutMs: 8_000 }))
    await vi.advanceTimersByTimeAsync(0)

    expect(seen).toEqual({ settled: true })
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('a bounded read lets go of everything it set up', () => {
  // A read's timer and its link to the caller's signal outlive nothing: a
  // leftover timer would fire stop() into a settled read, and a leftover
  // listener would let a later caller abort reach a request that already finished.
  test.each([
    ['an answer', () => Promise.resolve(ok()), undefined],
    [
      'an API error',
      () =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Slow down' } }), {
            status: 429,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      ApiError,
    ],
    ['a dropped connection', () => Promise.reject(new TypeError('Failed to fetch')), OfflineError],
  ])('after %s', async (_label, respond, expected) => {
    vi.useFakeTimers()
    fetchCall.mockImplementationOnce(respond)
    const caller = new AbortController()

    const seen = track(api.balances({ timeoutMs: 5_000, signal: caller.signal }))
    await vi.advanceTimersByTimeAsync(0)

    expect(seen.settled).toBe(true)
    if (expected) expect(seen.error).toBeInstanceOf(expected)
    else expect(seen.error).toBeUndefined()
    // The server's own answer is passed through, never renamed as a timeout.
    expect(seen.error).not.toBeInstanceOf(TimeoutError)
    expect(vi.getTimerCount()).toBe(0)

    caller.abort()
    expect(fetchInit()?.signal?.aborted).toBe(false)
  })

  test('after its deadline', async () => {
    vi.useFakeTimers()
    fetchCall.mockImplementation(hangingFetch)
    const caller = new AbortController()
    const unlinked = vi.spyOn(caller.signal, 'removeEventListener')

    const seen = track(api.balances({ timeoutMs: 5_000, signal: caller.signal }))
    await vi.advanceTimersByTimeAsync(5_000)

    expect(seen.error).toBeInstanceOf(TimeoutError)
    expect(vi.getTimerCount()).toBe(0)
    expect(unlinked).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  test('after a caller abort', async () => {
    vi.useFakeTimers()
    fetchCall.mockImplementation(hangingFetch)
    const caller = new AbortController()

    const seen = track(api.balances({ timeoutMs: 5_000, signal: caller.signal }))
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchCall).toHaveBeenCalledTimes(1)

    caller.abort()
    await vi.advanceTimersByTimeAsync(0)

    expect(seen.error).toMatchObject({ name: 'AbortError' })
    // The five-second timer must not survive to fire into a read that is over.
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('mutations never time out', () => {
  // Aborting a Drink or an Undo client-side could orphan a commit the server
  // already made; the person would then tap again. No signal, no timer.
  test.each([
    ['drink()', () => api.drink('key-1')],
    ['undo()', () => api.undo('op-1', 'key-2')],
  ])('%s passes no signal and is still pending after 60s', async (_label, mutate) => {
    vi.useFakeTimers()
    fetchCall.mockImplementation(hangingFetch)

    const seen = track(mutate())
    await vi.advanceTimersByTimeAsync(60_000)

    expect(fetchCall).toHaveBeenCalledTimes(1)
    expect(fetchInit()).not.toHaveProperty('signal')
    expect(vi.getTimerCount()).toBe(0)
    expect(seen.settled).toBe(false)
  })
})
