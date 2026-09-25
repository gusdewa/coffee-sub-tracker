import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const balancesCall = vi.fn()

vi.mock('../../src/api/client', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/api/client')>('../../src/api/client')
  return {
    ...actual,
    api: {
      balances: (...a: unknown[]) => balancesCall(...a),
    },
  }
})

const { useTeamBalances, TEAM_BALANCES_TIMEOUT_MS } = await import('../../src/state/teamBalances')
const { ApiError, OfflineError, TimeoutError } = await import('../../src/api/client')

const rows = [
  { memberId: 'M1', displayName: 'Dewa', remaining: 4 },
  { memberId: 'M2', displayName: 'Sari', remaining: 7 },
]

/** A balances call the test answers by hand, with the options it was given. */
function deferredBalances() {
  let resolve!: (value: { balances: typeof rows }) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<{ balances: typeof rows }>((res, rej) => {
    resolve = res
    reject = rej
  })
  balancesCall.mockReturnValueOnce(promise)
  return { resolve, reject }
}

const optionsOf = (call = 0) =>
  balancesCall.mock.calls[call]?.[0] as { timeoutMs?: number; signal?: AbortSignal } | undefined

beforeEach(() => {
  balancesCall.mockReset()
  balancesCall.mockResolvedValue({ balances: rows })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useTeamBalances', () => {
  test('bounds the read at five seconds and hands over the rows', async () => {
    const { result } = renderHook(() => useTeamBalances(true))

    expect(result.current).toEqual({ status: 'loading' })
    await waitFor(() => expect(result.current).toEqual({ status: 'ready', rows }))

    expect(TEAM_BALANCES_TIMEOUT_MS).toBe(5_000)
    expect(balancesCall).toHaveBeenCalledTimes(1)
    expect(optionsOf()).toEqual({ timeoutMs: TEAM_BALANCES_TIMEOUT_MS, signal: expect.any(AbortSignal) })
  })

  test('a timeout is reported as such, so the share can say why it is self-only', async () => {
    balancesCall.mockRejectedValueOnce(new TimeoutError())

    const { result } = renderHook(() => useTeamBalances(true))

    await waitFor(() =>
      expect(result.current).toEqual({ status: 'unavailable', reason: 'timeout' }),
    )
  })

  test.each([
    ['an API error', new ApiError('RATE_LIMITED', 'Slow down', 429)],
    ['a dropped connection', new OfflineError()],
    ['anything else', new Error('boom')],
  ])('%s becomes unavailable/error', async (_label, error) => {
    balancesCall.mockRejectedValueOnce(error)

    const { result } = renderHook(() => useTeamBalances(true))

    await waitFor(() => expect(result.current).toEqual({ status: 'unavailable', reason: 'error' }))
  })

  test('is not fetched while disabled, and fetches once enabled', async () => {
    const { result, rerender } = renderHook(({ enabled }) => useTeamBalances(enabled), {
      initialProps: { enabled: false },
    })

    expect(result.current).toEqual({ status: 'loading' })
    expect(balancesCall).not.toHaveBeenCalled()

    rerender({ enabled: true })
    await waitFor(() => expect(result.current).toEqual({ status: 'ready', rows }))
    expect(balancesCall).toHaveBeenCalledTimes(1)
  })

  test('aborts on unmount and ignores the answer that follows', async () => {
    const pending = deferredBalances()
    const consoleError = vi.spyOn(console, 'error')

    const { unmount } = renderHook(() => useTeamBalances(true))
    const signal = optionsOf()?.signal
    expect(signal?.aborted).toBe(false)

    unmount()
    expect(signal?.aborted).toBe(true)

    // The client rejects its own aborted read with AbortError; that is not a failure to show.
    pending.reject(new DOMException('The read was aborted.', 'AbortError'))
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))

    expect(consoleError).not.toHaveBeenCalled()
  })

  test('disabling aborts the read in flight and drops back to loading', async () => {
    const pending = deferredBalances()

    const { result, rerender } = renderHook(({ enabled }) => useTeamBalances(enabled), {
      initialProps: { enabled: true },
    })
    const signal = optionsOf()?.signal

    rerender({ enabled: false })
    expect(signal?.aborted).toBe(true)

    pending.resolve({ balances: rows })
    await new Promise((r) => setTimeout(r, 0))
    expect(result.current).toEqual({ status: 'loading' })
  })

  test.each([
    ['answer', (p: ReturnType<typeof deferredBalances>) => p.resolve({ balances: rows })],
    [
      'AbortError',
      (p: ReturnType<typeof deferredBalances>) =>
        p.reject(new DOMException('The read was aborted.', 'AbortError')),
    ],
  ])('an aborted read’s late %s never surfaces after re-enabling', async (_label, settle) => {
    const aborted = deferredBalances()
    deferredBalances() // the re-enabled read stays in flight

    const { result, rerender } = renderHook(({ enabled }) => useTeamBalances(enabled, 'op1'), {
      initialProps: { enabled: true },
    })
    rerender({ enabled: false })
    settle(aborted)
    await new Promise((r) => setTimeout(r, 0))

    rerender({ enabled: true })
    await new Promise((r) => setTimeout(r, 0))

    expect(balancesCall).toHaveBeenCalledTimes(2)
    expect(result.current).toEqual({ status: 'loading' })
  })

  test('a new key re-fetches, aborts the old read, and never shows its late answer', async () => {
    const first = deferredBalances()
    const second = deferredBalances()
    const newer = [{ memberId: 'M1', displayName: 'Dewa', remaining: 3 }]

    const { result, rerender } = renderHook(({ key }) => useTeamBalances(true, key), {
      initialProps: { key: 'op1' },
    })
    const firstSignal = optionsOf(0)?.signal

    rerender({ key: 'op2' })
    expect(balancesCall).toHaveBeenCalledTimes(2)
    expect(firstSignal?.aborted).toBe(true)
    expect(optionsOf(1)?.signal?.aborted).toBe(false)

    // The superseded read answers late; it must not be taken for the new key.
    first.resolve({ balances: rows })
    await new Promise((r) => setTimeout(r, 0))
    expect(result.current).toEqual({ status: 'loading' })

    second.resolve({ balances: newer })
    await waitFor(() => expect(result.current).toEqual({ status: 'ready', rows: newer }))
  })

  test('the same key does not re-fetch on re-render', async () => {
    const { result, rerender } = renderHook(({ key }) => useTeamBalances(true, key), {
      initialProps: { key: 'op1' },
    })
    await waitFor(() => expect(result.current.status).toBe('ready'))

    rerender({ key: 'op1' })

    expect(balancesCall).toHaveBeenCalledTimes(1)
    expect(result.current).toEqual({ status: 'ready', rows })
  })
})
