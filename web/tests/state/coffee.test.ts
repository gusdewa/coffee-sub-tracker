import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const me = vi.fn()
const drinkCall = vi.fn()
const undoCall = vi.fn()

vi.mock('../../src/api/client', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/api/client')>('../../src/api/client')
  return {
    ...actual,
    api: {
      me: (...a: unknown[]) => me(...a),
      drink: (...a: unknown[]) => drinkCall(...a),
      undo: (...a: unknown[]) => undoCall(...a),
    },
  }
})

const store = await import('../../src/state/coffee')
const { ApiError, OfflineError } = await import('../../src/api/client')

const balance = (totalRemaining: number) => ({
  member: { memberId: 'M1', displayName: 'Dewa', role: 'member' as const, isQa: false },
  totalRemaining,
  allocations: [
    {
      batchId: 'B1',
      batchLabel: 'September beans',
      granted: 5,
      consumed: 5 - totalRemaining,
      remaining: totalRemaining,
      effectiveAt: '2026-09-01T00:00:00.000Z',
      allocRowKey: 'A|SEPTEMBER',
    },
  ],
})

const drinkResult = (overrides: Record<string, unknown> = {}) => ({
  opId: 'op1',
  batchLabel: 'September beans',
  allocRowKey: 'A|SEPTEMBER',
  remainingTotal: 4,
  createdAt: new Date(Date.now()).toISOString(),
  undoExpiresAt: new Date(Date.now() + 90_000).toISOString(),
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  store.resetCoffeeStore()
  me.mockResolvedValue(balance(5))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the coffee store', () => {
  test('hydrates today’s server-backed Put Back offer after a reload', async () => {
    vi.useFakeTimers()
    const undoExpiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString()
    me.mockResolvedValue({
      ...balance(4),
      undoOffer: {
        opId: 'morning-op',
        allocRowKey: 'A|SEPTEMBER',
        batchId: 'B1',
        batchLabel: 'September beans',
        createdAt: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
        undoExpiresAt,
      },
    })

    await store.loadMe()

    expect(store.getCoffeeState().undo).toEqual({
      opId: 'morning-op',
      allocRowKey: 'A|SEPTEMBER',
      batchId: 'B1',
      batchLabel: 'September beans',
      createdAt: expect.any(String),
      undoExpiresAt,
    })
    expect(vi.getTimerCount()).toBe(1)
  })

  test('simultaneous balance refreshes share one authoritative request', async () => {
    let release: (value: ReturnType<typeof balance>) => void = () => {}
    me.mockImplementation(() => new Promise((resolve) => (release = resolve)))

    const first = store.loadMe()
    const second = store.loadMe()

    expect(me).toHaveBeenCalledTimes(1)
    release(balance(5))
    await Promise.all([first, second])
    expect(store.getCoffeeState().data?.totalRemaining).toBe(5)
  })

  test('a pre-mutation refresh cannot overwrite Drink or absorb its authoritative refresh', async () => {
    await store.loadMe()
    let releaseStale: (value: ReturnType<typeof balance>) => void = () => {}
    let releaseFresh: (value: ReturnType<typeof balance>) => void = () => {}
    me
      .mockImplementationOnce(() => new Promise((resolve) => (releaseStale = resolve)))
      .mockImplementationOnce(() => new Promise((resolve) => (releaseFresh = resolve)))
    drinkCall.mockResolvedValue(drinkResult({ batchLabel: 'B' }))

    const staleRefresh = store.loadMe()
    await store.drink()

    expect(me).toHaveBeenCalledTimes(3)
    releaseFresh(balance(4))
    await vi.waitFor(() => expect(store.getCoffeeState().data?.totalRemaining).toBe(4))
    releaseStale(balance(0))
    await staleRefresh
    expect(store.getCoffeeState().data?.totalRemaining).toBe(4)
  })

  test('a drink taken anywhere leaves an undo the whole app can see', async () => {
    drinkCall.mockResolvedValue(drinkResult())
    await store.loadMe()
    // The refetch after a drink is authoritative, so the stub has to move too.
    me.mockResolvedValue(balance(4))
    await store.drink()

    // The undo lives in the module, not in whichever screen happened to be
    // mounted. Navigating away used to destroy a live display window.
    expect(store.getCoffeeState().undo).toMatchObject({
      opId: 'op1',
      batchLabel: 'September beans',
    })
    expect(store.getCoffeeState().data?.totalRemaining).toBe(4)
  })

  test('requires confirmation at the mutation boundary and gives a confirmed drink its own deadline', async () => {
    vi.useFakeTimers()
    const firstDeadline = new Date(Date.now() + 90_000).toISOString()
    const secondDeadline = new Date(Date.now() + 120_000).toISOString()
    drinkCall
      .mockResolvedValueOnce(drinkResult({ opId: 'op1', batchLabel: 'B', undoExpiresAt: firstDeadline }))
      .mockResolvedValueOnce(drinkResult({ opId: 'op2', batchLabel: 'B', remainingTotal: 3, undoExpiresAt: secondDeadline }))
    await store.loadMe()

    await store.drink()
    await vi.advanceTimersByTimeAsync(5_000)
    await store.drink()
    expect(drinkCall).toHaveBeenCalledTimes(1)

    await store.drink({ confirmedAnother: true })
    expect(drinkCall).toHaveBeenCalledTimes(2)
    expect(store.getCoffeeState().undo?.opId).toBe('op2')

    // The old deadline cannot clear the newer offer.
    await vi.advanceTimersByTimeAsync(85_000)
    expect(store.getCoffeeState().undo?.opId).toBe('op2')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(store.getCoffeeState().undo).toBeNull()
  })

  test('the 10 second success notice expires without discarding server-backed undo eligibility', async () => {
    vi.useFakeTimers()
    const deadline = new Date(Date.now() + 90_000).toISOString()
    drinkCall.mockResolvedValue({
      opId: 'op1', batchLabel: 'B', allocRowKey: 'A|SEPTEMBER', remainingTotal: 4,
      createdAt: new Date().toISOString(), undoExpiresAt: deadline,
    })
    await store.loadMe()
    await store.drink()

    await vi.advanceTimersByTimeAsync(9_000)
    expect(store.getCoffeeState().notice).not.toBeNull()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(store.getCoffeeState().notice).toBeNull()
    expect(store.getCoffeeState().undo).toMatchObject({
      opId: 'op1', allocRowKey: 'A|SEPTEMBER', undoExpiresAt: deadline,
    })
  })

  test('authoritative expiry removes the card offer while a transient undo failure retains it', async () => {
    drinkCall.mockResolvedValue({
      opId: 'op1', batchLabel: 'B', allocRowKey: 'A|SEPTEMBER', remainingTotal: 4,
      createdAt: new Date().toISOString(), undoExpiresAt: new Date(Date.now() + 90_000).toISOString(),
    })
    await store.loadMe()
    await store.drink()
    undoCall.mockRejectedValueOnce(new Error('temporary'))
    await store.undoDrink()
    expect(store.getCoffeeState().undo?.opId).toBe('op1')
    undoCall.mockRejectedValueOnce(new ApiError('UNDO_WINDOW_EXPIRED', 'expired', 409))
    await store.undoDrink()
    expect(store.getCoffeeState().undo).toBeNull()
  })

  test('a stale offer is cleared when the server says it is not the latest consume', async () => {
    drinkCall.mockResolvedValue(drinkResult())
    await store.loadMe()
    await store.drink()
    undoCall.mockRejectedValueOnce(
      new ApiError('NOT_LATEST_CONSUME', 'Only the latest drink can be undone', 409),
    )

    await store.undoDrink()

    expect(store.getCoffeeState().undo).toBeNull()
    expect(store.getCoffeeState().error).toMatchObject({ code: 'NOT_LATEST_CONSUME' })
  })

  test('reset cleans up the pending Put it back expiry timer', async () => {
    vi.useFakeTimers()
    drinkCall.mockResolvedValue(drinkResult({ batchLabel: 'B' }))
    await store.loadMe()
    await store.drink()
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    store.resetCoffeeStore()
    expect(vi.getTimerCount()).toBe(0)
  })

  test('a double tap sends one request with one idempotency key', async () => {
    let release: (v: unknown) => void = () => {}
    drinkCall.mockImplementation(() => new Promise((res) => (release = res)))
    await store.loadMe()

    const first = store.drink()
    const second = store.drink()
    expect(drinkCall).toHaveBeenCalledTimes(1)

    release(drinkResult({ batchLabel: 'B' }))
    await Promise.all([first, second])
    expect(drinkCall).toHaveBeenCalledTimes(1)
    expect(drinkCall.mock.calls[0]![0]).toEqual(expect.any(String))
  })

  test('offline refuses the mutation instead of failing after the fact', async () => {
    await store.loadMe()
    window.dispatchEvent(new Event('offline'))
    expect(store.getCoffeeState().offline).toBe(true)

    await store.drink()
    expect(drinkCall).not.toHaveBeenCalled()

    window.dispatchEvent(new Event('online'))
    expect(store.getCoffeeState().offline).toBe(false)
  })

  test('undo puts the cup back and clears the window', async () => {
    drinkCall.mockResolvedValue(drinkResult({ batchLabel: 'B' }))
    undoCall.mockResolvedValue({ remainingTotal: 5 })
    await store.loadMe()
    await store.drink()
    await store.undoDrink()

    expect(undoCall).toHaveBeenCalledWith('op1', expect.any(String))
    expect(store.getCoffeeState().undo).toBeNull()
    expect(store.getCoffeeState().notice).toBeNull()
  })

  test('an unbound account surfaces as an error rather than being swallowed', async () => {
    // App.tsx depends on this rejection to route to ClaimIdentity.
    me.mockRejectedValue(new ApiError('ACCOUNT_UNBOUND', 'not bound', 403))
    await store.loadMe()
    const { error } = store.getCoffeeState()
    expect(error).toBeInstanceOf(ApiError)
    expect((error as InstanceType<typeof ApiError>).code).toBe('ACCOUNT_UNBOUND')
  })

  test('a failed drink is reported and does not arm an undo', async () => {
    drinkCall.mockRejectedValue(new OfflineError())
    await store.loadMe()
    await store.drink()
    expect(store.getCoffeeState().error).toBeInstanceOf(OfflineError)
    expect(store.getCoffeeState().undo).toBeNull()
    expect(store.getCoffeeState().busy).toBe(false)
  })

  test('revision bumps once per successful mutation so sibling screens reload', async () => {
    drinkCall.mockResolvedValue(drinkResult({ batchLabel: 'B' }))
    undoCall.mockResolvedValue({ remainingTotal: 5 })
    await store.loadMe()

    const start = store.getCoffeeState().revision
    await store.drink()
    expect(store.getCoffeeState().revision).toBe(start + 1)
    await store.undoDrink()
    expect(store.getCoffeeState().revision).toBe(start + 2)
  })

  test('subscribers are notified and can unsubscribe', async () => {
    const seen = vi.fn()
    const off = store.subscribeCoffee(seen)
    await store.loadMe()
    expect(seen).toHaveBeenCalled()
    off()
    const count = seen.mock.calls.length
    await store.loadMe()
    expect(seen.mock.calls.length).toBe(count)
  })

  test('mutations go through the guarded api client, never raw fetch', () => {
    // withMutationGuard wraps api.drink/api.undo in the client, which is what
    // stops a service-worker activation landing mid-transaction. Reaching for
    // fetch here would silently step around it.
    const src = readFileSync(resolve(__dirname, '../../src/state/coffee.ts'), 'utf8')
    expect(src).toMatch(/from '\.\.\/api\/client'/)
    expect(src).not.toMatch(/\bfetch\s*\(/)
  })
})
