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
    },
  ],
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
    drinkCall.mockResolvedValue({ opId: 'op1', batchLabel: 'B', remainingTotal: 4 })

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
    drinkCall.mockResolvedValue({
      opId: 'op1',
      batchLabel: 'September beans',
      remainingTotal: 4,
    })
    await store.loadMe()
    // The refetch after a drink is authoritative, so the stub has to move too.
    me.mockResolvedValue(balance(4))
    await store.drink()

    // The undo lives in the module, not in whichever screen happened to be
    // mounted. Navigating away used to destroy a live 90-second window.
    expect(store.getCoffeeState().undo).toMatchObject({
      opId: 'op1',
      batchLabel: 'September beans',
    })
    expect(store.getCoffeeState().data?.totalRemaining).toBe(4)
  })

  test('a second drink does not have its undo cut short by the first timer', async () => {
    vi.useFakeTimers()
    drinkCall
      .mockResolvedValueOnce({ opId: 'op1', batchLabel: 'B', remainingTotal: 4 })
      .mockResolvedValueOnce({ opId: 'op2', batchLabel: 'B', remainingTotal: 3 })
    await store.loadMe()

    await store.drink()
    await vi.advanceTimersByTimeAsync(10_000)
    await store.drink()
    expect(store.getCoffeeState().undo?.opId).toBe('op2')

    // 81s after the second drink: the first drink's stale timeout would fire at
    // 90s from *its* start and wrongly clear this one.
    await vi.advanceTimersByTimeAsync(81_000)
    expect(store.getCoffeeState().undo?.opId).toBe('op2')

    await vi.advanceTimersByTimeAsync(10_000)
    expect(store.getCoffeeState().undo).toBeNull()
  })

  test('the undo window expires on its own after 90 seconds', async () => {
    vi.useFakeTimers()
    drinkCall.mockResolvedValue({ opId: 'op1', batchLabel: 'B', remainingTotal: 4 })
    await store.loadMe()
    await store.drink()

    await vi.advanceTimersByTimeAsync(89_000)
    expect(store.getCoffeeState().undo).not.toBeNull()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(store.getCoffeeState().undo).toBeNull()
  })

  test('a double tap sends one request with one idempotency key', async () => {
    let release: (v: unknown) => void = () => {}
    drinkCall.mockImplementation(() => new Promise((res) => (release = res)))
    await store.loadMe()

    const first = store.drink()
    const second = store.drink()
    expect(drinkCall).toHaveBeenCalledTimes(1)

    release({ opId: 'op1', batchLabel: 'B', remainingTotal: 4 })
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
    drinkCall.mockResolvedValue({ opId: 'op1', batchLabel: 'B', remainingTotal: 4 })
    undoCall.mockResolvedValue({ remainingTotal: 5 })
    await store.loadMe()
    await store.drink()
    await store.undoDrink()

    expect(undoCall).toHaveBeenCalledWith('op1', expect.any(String))
    expect(store.getCoffeeState().undo).toBeNull()
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
    drinkCall.mockResolvedValue({ opId: 'op1', batchLabel: 'B', remainingTotal: 4 })
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
