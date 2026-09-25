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
const { ApiError, OfflineError, UnconfirmedDrinkError } = await import('../../src/api/client')

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
  vi.restoreAllMocks()
})

/** Every state the store published while `run` ran, in order. */
async function published(run: () => Promise<unknown>) {
  const seen: ReturnType<typeof store.getCoffeeState>[] = []
  const off = store.subscribeCoffee(() => seen.push(store.getCoffeeState()))
  try {
    await run()
  } finally {
    off()
  }
  return seen
}

/** Lets every settled promise run its handlers, a refresh's catch included. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** A browser that still believes it is online, or one that knows it is not. */
const browserOnline = (onLine: boolean) =>
  vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(onLine)

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

  test('the receipt lasts until dismissed, independent of the undo deadline', async () => {
    vi.useFakeTimers()
    const deadline = new Date(Date.now() + 90_000).toISOString()
    drinkCall.mockResolvedValue({
      opId: 'op1', batchLabel: 'B', allocRowKey: 'A|SEPTEMBER', remainingTotal: 4,
      createdAt: new Date().toISOString(), undoExpiresAt: deadline,
    })
    await store.loadMe()
    await store.drink()

    // Long past the old ten-second notice: the summary is the person's to close.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(store.getCoffeeState().receipt).toMatchObject({ opId: 'op1', status: 'counted' })
    expect(store.getCoffeeState().undo).toMatchObject({
      opId: 'op1', allocRowKey: 'A|SEPTEMBER', undoExpiresAt: deadline,
    })

    // And the server deadline ends only the offer, never the receipt.
    await vi.advanceTimersByTimeAsync(81_000)
    expect(store.getCoffeeState().undo).toBeNull()
    expect(store.getCoffeeState().receipt).toMatchObject({ opId: 'op1', status: 'counted' })

    store.dismissReceipt()
    expect(store.getCoffeeState().receipt).toBeNull()
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
    // Both failures belong to the cup's own Put Back, never to the shell's error.
    expect(store.getCoffeeState().undoError).toMatchObject({
      opId: 'op1',
      error: { code: 'UNDO_WINDOW_EXPIRED' },
    })
    expect(store.getCoffeeState().error).toBeNull()
  })

  test('a stale offer is cleared when the server says it is not the latest consume', async () => {
    drinkCall.mockResolvedValue(drinkResult())
    await store.loadMe()
    await store.drink()
    const error = new ApiError('NOT_LATEST_CONSUME', 'Only the latest drink can be undone', 409)
    undoCall.mockRejectedValueOnce(error)
    const before = me.mock.calls.length

    expect(await store.undoDrink('op1')).toBe(false)

    const state = store.getCoffeeState()
    expect(state.undo).toBeNull()
    // The cup stays counted: a newer one owns the offer, not this receipt.
    expect(state.receipt).toMatchObject({ opId: 'op1', status: 'counted' })
    expect(state.undoError).toEqual({ opId: 'op1', error })
    expect(state.error).toBeNull()
    // /api/me knows which cup is latest now; ask it rather than guess.
    await vi.waitFor(() => expect(me).toHaveBeenCalledTimes(before + 1))
  })

  test('NOT_LATEST_CONSUME never clears the newer cup’s offer a refresh brought in meanwhile', async () => {
    drinkCall.mockResolvedValue(drinkResult())
    await store.loadMe()
    await store.drink()
    await flush()
    let refuse: (error: Error) => void = () => {}
    undoCall.mockImplementationOnce(() => new Promise((_resolve, reject) => (refuse = reject)))
    const putBack = store.undoDrink('op1')

    // Another device counted op2 while this Put Back was out; the poll saw it.
    me.mockResolvedValueOnce({
      ...balance(3),
      undoOffer: {
        opId: 'op2',
        allocRowKey: 'A|SEPTEMBER',
        batchId: 'B1',
        batchLabel: 'September beans',
        createdAt: new Date().toISOString(),
        undoExpiresAt: new Date(Date.now() + 90_000).toISOString(),
      },
    })
    await store.loadMe()
    expect(store.getCoffeeState().undo?.opId).toBe('op2')
    // The follow-up read never answers, so only the store's own handling is seen.
    me.mockImplementationOnce(() => new Promise(() => {}))

    refuse(new ApiError('NOT_LATEST_CONSUME', 'Only the latest drink can be undone', 409))
    expect(await putBack).toBe(false)

    const state = store.getCoffeeState()
    expect(state.undo?.opId).toBe('op2')
    expect(state.undoError).toMatchObject({ opId: 'op1', error: { code: 'NOT_LATEST_CONSUME' } })
    expect(state.receipt).toMatchObject({ opId: 'op1', status: 'counted' })
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
    expect(store.getCoffeeState().receipt).toMatchObject({ opId: 'op1', status: 'putBack' })
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
    // The browser itself knows it is offline, so "not counted" is honest.
    browserOnline(false)
    await store.drink()
    expect(store.getCoffeeState().error).toBeInstanceOf(OfflineError)
    expect(store.getCoffeeState().undo).toBeNull()
    expect(store.getCoffeeState().receipt).toBeNull()
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

  test('a successful Drink publishes its receipt in the same update as the balance and offer', async () => {
    const createdAt = new Date().toISOString()
    const undoExpiresAt = new Date(Date.now() + 90_000).toISOString()
    drinkCall.mockResolvedValue(drinkResult({ batchId: 'B1', createdAt, undoExpiresAt, replayed: false }))
    await store.loadMe()
    me.mockResolvedValue(balance(4))
    const start = store.getCoffeeState().revision

    const seen = await published(() => store.drink())

    const receipt = {
      opId: 'op1',
      batchLabel: 'September beans',
      allocRowKey: 'A|SEPTEMBER',
      batchId: 'B1',
      createdAt,
      undoExpiresAt,
      replayed: false,
      memberId: 'M1',
      memberName: 'Dewa',
      status: 'counted',
    }
    expect(store.getCoffeeState().receipt).toEqual(receipt)
    // One notification carries all of it, so no render can see the new
    // balance without the receipt, or the receipt without its Put Back.
    const first = seen.find((s) => s.receipt !== null)!
    expect(first.undo?.opId).toBe('op1')
    expect(first.data?.totalRemaining).toBe(4)
    expect(first.revision).toBe(start + 1)
    expect(first.undoError).toBeNull()
  })

  test('a counted Drink never sits beside a stale "not counted" from a read that failed meanwhile', async () => {
    await store.loadMe()
    let failStale: (error: Error) => void = () => {}
    me.mockImplementationOnce(() => new Promise((_resolve, reject) => (failStale = reject)))
    const stale = store.loadMe()
    let answer: (value: unknown) => void = () => {}
    drinkCall.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
    const drinking = store.drink()

    // The poll that was already out fails while the Drink is still in flight.
    failStale(new OfflineError())
    await stale
    expect(store.getCoffeeState().error).toBeInstanceOf(OfflineError)
    // The Drink's own follow-up read never answers, so only the success is seen.
    me.mockImplementationOnce(() => new Promise(() => {}))

    answer(drinkResult())
    await drinking

    expect(store.getCoffeeState().receipt).toMatchObject({ opId: 'op1', status: 'counted' })
    expect(store.getCoffeeState().error).toBeNull()
  })

  test('no receipt comes from a refused, guarded or offline Drink', async () => {
    // No balance yet: guarded.
    expect(await store.drink()).toBeNull()
    expect(store.getCoffeeState().receipt).toBeNull()

    await store.loadMe()
    drinkCall.mockRejectedValueOnce(new ApiError('NO_BALANCE', 'none', 409))
    await store.drink()
    expect(store.getCoffeeState().receipt).toBeNull()

    window.dispatchEvent(new Event('offline'))
    await store.drink()
    window.dispatchEvent(new Event('online'))
    expect(store.getCoffeeState().receipt).toBeNull()
    expect(drinkCall).toHaveBeenCalledTimes(1)
  })

  test('an older API’s bare response still yields a receipt and a working offer', async () => {
    vi.useFakeTimers()
    // What an API from before the deadline and allocation fields answers with.
    drinkCall.mockResolvedValue({ opId: 'op1', batchLabel: 'September beans', remainingTotal: 4 })
    undoCall.mockResolvedValue({ remainingTotal: 5 })
    await store.loadMe()
    me.mockResolvedValue(balance(4))

    await store.drink()

    expect(store.getCoffeeState().receipt).toEqual({
      opId: 'op1',
      batchLabel: 'September beans',
      allocRowKey: '',
      batchId: '',
      createdAt: null,
      undoExpiresAt: null,
      replayed: false,
      memberId: 'M1',
      memberName: 'Dewa',
      status: 'counted',
    })
    expect(store.getCoffeeState().undo).toEqual({
      opId: 'op1',
      batchLabel: 'September beans',
      allocRowKey: '',
      batchId: '',
      createdAt: null,
      undoExpiresAt: null,
    })
    expect(store.getCoffeeState().data?.totalRemaining).toBe(4)
    // No deadline, so no NaN timer: the server rejects a late undo itself.
    expect(vi.getTimerCount()).toBe(0)

    expect(await store.undoDrink('op1')).toBe(true)
    expect(undoCall).toHaveBeenCalledWith('op1', expect.any(String))
  })

  test('unparseable timestamps become null rather than an Invalid Date', async () => {
    drinkCall.mockResolvedValue(drinkResult({ createdAt: 'yesterday-ish', undoExpiresAt: '' }))
    await store.loadMe()
    await store.drink()
    expect(store.getCoffeeState().receipt).toMatchObject({ createdAt: null, undoExpiresAt: null })
    expect(store.getCoffeeState().undo).toMatchObject({ createdAt: null, undoExpiresAt: null })
  })

  test('a replayed Drink is still one tap and one receipt', async () => {
    drinkCall.mockResolvedValue(drinkResult({ replayed: true }))
    await store.loadMe()

    const seen = await published(() => store.drink())

    expect(drinkCall).toHaveBeenCalledTimes(1)
    expect(store.getCoffeeState().receipt).toMatchObject({ opId: 'op1', replayed: true })
    expect(new Set(seen.map((s) => s.receipt).filter(Boolean)).size).toBe(1)
  })

  test('dismissing the receipt keeps the card’s Put Back', async () => {
    drinkCall.mockResolvedValue(drinkResult())
    await store.loadMe()
    await store.drink()
    undoCall.mockRejectedValueOnce(new OfflineError())
    await store.undoDrink('op1')
    expect(store.getCoffeeState().undoError).not.toBeNull()

    store.dismissReceipt()

    expect(store.getCoffeeState().receipt).toBeNull()
    expect(store.getCoffeeState().undoError).toBeNull()
    expect(store.getCoffeeState().undo?.opId).toBe('op1')
  })

  test('Put Back for one cup never reverses another', async () => {
    drinkCall.mockResolvedValue(drinkResult())
    await store.loadMe()
    await store.drink()

    expect(await store.undoDrink('some-older-op')).toBe(false)

    expect(undoCall).not.toHaveBeenCalled()
    expect(store.getCoffeeState().undo?.opId).toBe('op1')
    expect(store.getCoffeeState().receipt?.status).toBe('counted')
  })

  test('a successful Put Back flips the receipt in the same update that clears the offer', async () => {
    drinkCall.mockResolvedValue(drinkResult())
    undoCall.mockResolvedValue({ remainingTotal: 5 })
    await store.loadMe()
    await store.drink()
    const start = store.getCoffeeState().revision

    let result: boolean | undefined
    const seen = await published(async () => (result = await store.undoDrink('op1')))

    expect(result).toBe(true)
    const flipped = seen.find((s) => s.receipt?.status === 'putBack')!
    expect(flipped.undo).toBeNull()
    expect(flipped.data?.totalRemaining).toBe(5)
    expect(flipped.revision).toBe(start + 1)
    // Never a frame where the offer is gone but the receipt still says counted.
    expect(seen.every((s) => (s.undo === null) === (s.receipt?.status === 'putBack'))).toBe(true)
  })

  test.each([
    ['the server confirms it', () => undoCall.mockResolvedValueOnce({ remainingTotal: 5 })],
    [
      'the server says it is already back',
      () => undoCall.mockRejectedValueOnce(new ApiError('ALREADY_UNDONE', 'already undone', 409)),
    ],
  ])('when %s, the cup goes back on its own card in the same update as the balance', async (_label, answer) => {
    drinkCall.mockResolvedValue(drinkResult())
    await store.loadMe()
    // /api/me stays out, so only the store's own patch can move the card.
    me.mockReturnValue(new Promise(() => {}))
    await store.drink()
    expect(store.getCoffeeState().data?.allocations[0]).toMatchObject({ consumed: 1, remaining: 4 })
    answer()

    const seen = await published(() => store.undoDrink('op1'))

    const flipped = seen.find((s) => s.receipt?.status === 'putBack')!
    expect(flipped.data?.totalRemaining).toBe(5)
    expect(flipped.data?.allocations[0]).toMatchObject({ consumed: 0, remaining: 5 })
  })

  test('a Put Back finds an older API’s card by batch, and never fills a card past its grant', async () => {
    // No allocRowKey: the cup is matched to its card by batchId instead.
    drinkCall.mockResolvedValue(drinkResult({ allocRowKey: undefined, batchId: 'B1' }))
    undoCall.mockResolvedValueOnce({ remainingTotal: 5 })
    await store.loadMe()
    // A refresh already reports the card full again, while the offer is still this cup's.
    me.mockResolvedValue({
      ...balance(5),
      undoOffer: {
        opId: 'op1', batchLabel: 'September beans', allocRowKey: '', batchId: 'B1',
        createdAt: new Date().toISOString(),
        undoExpiresAt: new Date(Date.now() + 90_000).toISOString(),
      },
    })
    await store.drink()
    await vi.waitFor(() => expect(store.getCoffeeState().data?.allocations[0]?.remaining).toBe(5))
    me.mockReturnValue(new Promise(() => {}))

    expect(await store.undoDrink('op1')).toBe(true)

    expect(store.getCoffeeState().data?.allocations[0]).toMatchObject({ consumed: 0, remaining: 5 })
  })

  test('ALREADY_UNDONE is the server saying the cup is back: put back, and ask /api/me', async () => {
    drinkCall.mockResolvedValue(drinkResult())
    await store.loadMe()
    await store.drink()
    await vi.waitFor(() => expect(me).toHaveBeenCalledTimes(2))
    undoCall.mockRejectedValueOnce(new ApiError('ALREADY_UNDONE', 'already undone', 409))
    const start = store.getCoffeeState().revision

    expect(await store.undoDrink('op1')).toBe(true)

    const state = store.getCoffeeState()
    expect(state.receipt).toMatchObject({ opId: 'op1', status: 'putBack' })
    expect(state.undo).toBeNull()
    expect(state.undoError).toBeNull()
    expect(state.error).toBeNull()
    expect(state.revision).toBe(start + 1)
    // The balance it put back is the server's to report.
    await vi.waitFor(() => expect(me).toHaveBeenCalledTimes(3))
  })

  test('a Put Back that never answered keeps the offer and stays out of the shared error', async () => {
    drinkCall.mockResolvedValue(drinkResult())
    await store.loadMe()
    await store.drink()
    await vi.waitFor(() => expect(me).toHaveBeenCalledTimes(2))
    const error = new OfflineError()
    undoCall.mockRejectedValueOnce(error)

    expect(await store.undoDrink('op1')).toBe(false)

    const state = store.getCoffeeState()
    expect(state.undoError).toEqual({ opId: 'op1', error })
    expect(state.undo?.opId).toBe('op1')
    expect(state.receipt?.status).toBe('counted')
    expect(state.error).toBeNull()
    expect(state.busy).toBe(false)
    // It may have committed before the answer was lost; /api/me will say.
    await vi.waitFor(() => expect(me).toHaveBeenCalledTimes(3))
  })

  test('a refresh that also fails after a failed Put Back stays out of the shared error', async () => {
    drinkCall.mockResolvedValue(drinkResult())
    await store.loadMe()
    await store.drink()
    await flush()
    undoCall.mockRejectedValueOnce(new OfflineError())
    me.mockRejectedValueOnce(new OfflineError())

    await store.undoDrink('op1')
    await vi.waitFor(() => expect(me).toHaveBeenCalledTimes(3))
    await flush()

    expect(store.getCoffeeState().error).toBeNull()
    expect(store.getCoffeeState().undoError?.error).toBeInstanceOf(OfflineError)
  })

  test('a Drink whose answer was lost while online is unconfirmed, and /api/me arms the guard', async () => {
    await store.loadMe()
    browserOnline(true)
    drinkCall.mockRejectedValueOnce(new OfflineError())
    let answer: (value: unknown) => void = () => {}
    me.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))

    expect(await store.drink()).toBeNull()

    // It may have been committed, so never "not counted".
    expect(store.getCoffeeState().error).toBeInstanceOf(UnconfirmedDrinkError)
    expect(store.getCoffeeState().receipt).toBeNull()
    expect(store.getCoffeeState().busy).toBe(false)
    expect(me).toHaveBeenCalledTimes(2)

    // It had been committed: the server's offer now guards the next tap.
    answer({
      ...balance(4),
      undoOffer: {
        opId: 'op1',
        allocRowKey: 'A|SEPTEMBER',
        batchId: 'B1',
        batchLabel: 'September beans',
        createdAt: new Date().toISOString(),
        undoExpiresAt: new Date(Date.now() + 90_000).toISOString(),
      },
    })
    await vi.waitFor(() => expect(store.getCoffeeState().undo?.opId).toBe('op1'))
    expect(await store.drink()).toBeNull()
    expect(drinkCall).toHaveBeenCalledTimes(1)
    // The answer arming the guard does not make "couldn't confirm" untrue, so
    // it stays until an ordinary refresh, as a Drink error always has.
    expect(store.getCoffeeState().error).toBeInstanceOf(UnconfirmedDrinkError)
    await store.loadMe()
    expect(store.getCoffeeState().error).toBeNull()
  })

  test('a failed refresh after an unconfirmed Drink does not turn it into "not counted"', async () => {
    await store.loadMe()
    browserOnline(true)
    drinkCall.mockRejectedValueOnce(new OfflineError())
    me.mockRejectedValueOnce(new OfflineError())

    await store.drink()

    await vi.waitFor(() => expect(me).toHaveBeenCalledTimes(2))
    await flush()
    expect(store.getCoffeeState().error).toBeInstanceOf(UnconfirmedDrinkError)
  })

  test('a later failed refresh keeps "couldn’t confirm", but an answer from the API replaces it', async () => {
    await store.loadMe()
    browserOnline(true)
    drinkCall.mockRejectedValueOnce(new OfflineError())
    me.mockRejectedValueOnce(new OfflineError())
    await store.drink()
    await flush()

    // The 60-second poll, a return to the tab, or Try again, still offline.
    me.mockRejectedValueOnce(new OfflineError())
    await store.loadMe()
    expect(store.getCoffeeState().error).toBeInstanceOf(UnconfirmedDrinkError)

    me.mockRejectedValueOnce(new ApiError('ACCOUNT_UNBOUND', 'not bound', 403))
    await store.loadMe()
    expect(store.getCoffeeState().error).toMatchObject({ code: 'ACCOUNT_UNBOUND' })
  })

  test('the refresh after an unconfirmed Drink is not one that left before it', async () => {
    await store.loadMe()
    browserOnline(true)
    let answerStale: (value: unknown) => void = () => {}
    me.mockImplementationOnce(() => new Promise((resolve) => (answerStale = resolve)))
    const stale = store.loadMe()
    drinkCall.mockRejectedValueOnce(new OfflineError())
    me.mockResolvedValueOnce({
      ...balance(4),
      undoOffer: {
        opId: 'op1',
        allocRowKey: 'A|SEPTEMBER',
        batchId: 'B1',
        batchLabel: 'September beans',
        createdAt: new Date().toISOString(),
        undoExpiresAt: new Date(Date.now() + 90_000).toISOString(),
      },
    })

    await store.drink()
    // Joining the stale read would miss the Drink it never saw, and racing it
    // would let its pre-Drink answer land last. So nothing is asked until it settles.
    await flush()
    expect(me).toHaveBeenCalledTimes(2)
    answerStale({ ...balance(5), undoOffer: null })
    await stale

    await vi.waitFor(() => expect(me).toHaveBeenCalledTimes(3))
    await vi.waitFor(() => expect(store.getCoffeeState().undo?.opId).toBe('op1'))
    expect(store.getCoffeeState().data?.totalRemaining).toBe(4)
  })

  test('a refresh that left before an unconfirmed Drink cannot clear "couldn’t confirm"', async () => {
    await store.loadMe()
    browserOnline(true)
    let answerStale: (value: unknown) => void = () => {}
    me.mockImplementationOnce(() => new Promise((resolve) => (answerStale = resolve)))
    const stale = store.loadMe()
    drinkCall.mockRejectedValueOnce(new OfflineError())

    await store.drink()
    // The poll that was already out answers with the balance from before the tap.
    answerStale(balance(5))
    await stale

    // It never saw the Drink, so it knows nothing that makes the warning untrue.
    expect(store.getCoffeeState().error).toBeInstanceOf(UnconfirmedDrinkError)
    await vi.waitFor(() => expect(me).toHaveBeenCalledTimes(3))
    await flush()
    expect(store.getCoffeeState().error).toBeInstanceOf(UnconfirmedDrinkError)
  })

  test('a Drink refused while a refresh is out keeps its reason when that refresh lands', async () => {
    await store.loadMe()
    let answerStale: (value: unknown) => void = () => {}
    me.mockImplementationOnce(() => new Promise((resolve) => (answerStale = resolve)))
    const stale = store.loadMe()
    drinkCall.mockRejectedValueOnce(new ApiError('RATE_LIMITED', 'slow down', 429))

    await store.drink()
    answerStale(balance(5))
    await stale

    expect(store.getCoffeeState().error).toMatchObject({ code: 'RATE_LIMITED' })
    // A refresh asked for afterwards has seen the refusal, so it may clear it.
    await store.loadMe()
    expect(store.getCoffeeState().error).toBeNull()
  })

  test('an API refusal of a Drink is an answer, so it asks /api/me for nothing', async () => {
    await store.loadMe()
    drinkCall.mockRejectedValueOnce(new ApiError('NO_BALANCE', 'none', 409))

    await store.drink()
    await flush()

    expect(store.getCoffeeState().error).toMatchObject({ code: 'NO_BALANCE' })
    expect(me).toHaveBeenCalledTimes(1)
  })

  test('a failed Drink that never reached the network still asks /api/me', async () => {
    await store.loadMe()
    browserOnline(false)
    drinkCall.mockRejectedValueOnce(new OfflineError())

    await store.drink()

    expect(store.getCoffeeState().error).toBeInstanceOf(OfflineError)
    await vi.waitFor(() => expect(me).toHaveBeenCalledTimes(2))
  })

  test('a throwing randomUUID fails the Drink instead of leaving the store busy', async () => {
    await store.loadMe()
    vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
      throw new Error('crypto.randomUUID is unavailable in an insecure context')
    })

    expect(await store.drink()).toBeNull()

    expect(store.getCoffeeState().busy).toBe(false)
    expect(store.getCoffeeState().error).toBeInstanceOf(Error)
    expect(store.getCoffeeState().receipt).toBeNull()
    expect(drinkCall).not.toHaveBeenCalled()
  })

  test('the idempotency key is made only once every guard has passed', async () => {
    const uuid = vi.spyOn(crypto, 'randomUUID')
    drinkCall.mockResolvedValue(drinkResult())

    await store.drink() // no balance yet
    await store.loadMe()
    window.dispatchEvent(new Event('offline'))
    await store.drink()
    window.dispatchEvent(new Event('online'))
    expect(uuid).not.toHaveBeenCalled()

    await store.drink()
    expect(uuid).toHaveBeenCalledTimes(1)

    await store.drink() // the undo is pending and nobody confirmed another
    expect(uuid).toHaveBeenCalledTimes(1)
    expect(drinkCall).toHaveBeenCalledTimes(1)
    expect(drinkCall).toHaveBeenCalledWith(uuid.mock.results[0]!.value)
  })

  test('a refresh that finds a different offer leaves the receipt for the summary to judge', async () => {
    drinkCall.mockResolvedValue(drinkResult())
    await store.loadMe()
    me.mockResolvedValue({ ...balance(4), undoOffer: null })
    await store.drink()

    await vi.waitFor(() => expect(store.getCoffeeState().undo).toBeNull())
    expect(store.getCoffeeState().receipt).toMatchObject({ opId: 'op1', status: 'counted' })
  })

  test('reset forgets the receipt and any undo error', async () => {
    drinkCall.mockResolvedValue(drinkResult())
    undoCall.mockRejectedValueOnce(new OfflineError())
    await store.loadMe()
    await store.drink()
    await store.undoDrink('op1')

    store.resetCoffeeStore()

    expect(store.getCoffeeState().receipt).toBeNull()
    expect(store.getCoffeeState().undoError).toBeNull()
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
