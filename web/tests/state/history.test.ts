import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { StrictMode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { HistoryItem } from '../../src/api/client'

const me = vi.fn()
const historyCall = vi.fn()

vi.mock('../../src/api/client', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/api/client')>('../../src/api/client')
  return {
    ...actual,
    api: {
      me: (...a: unknown[]) => me(...a),
      history: (...a: unknown[]) => historyCall(...a),
    },
  }
})

const coffee = await import('../../src/state/coffee')
const {
  HISTORY_LIMIT,
  HISTORY_TIMEOUT_MS,
  getHistorySnapshot,
  historyKey,
  loadHistory,
  resetHistoryStore,
  useHistory,
} = await import('../../src/state/history')
const { ApiError, OfflineError, TimeoutError } = await import('../../src/api/client')

const row = (opId: string, overrides: Partial<HistoryItem> = {}): HistoryItem => ({
  opId,
  type: 'CONSUME',
  delta: -1,
  batchLabel: 'September beans',
  createdAt: '2026-09-25T02:00:00.000Z',
  reversed: false,
  ...overrides,
})

const balance = (totalRemaining: number, undoOpId: string | null = null, memberId = 'M1') => ({
  member: { memberId, displayName: 'Dewa', role: 'member' as const, isQa: false },
  totalRemaining,
  allocations: [
    {
      allocRowKey: 'A|SEPTEMBER',
      batchId: 'B1',
      batchLabel: 'September beans',
      granted: 8,
      consumed: 8 - totalRemaining,
      remaining: totalRemaining,
      effectiveAt: '2026-09-01T00:00:00.000Z',
    },
  ],
  undoOffer: undoOpId
    ? {
        opId: undoOpId,
        allocRowKey: 'A|SEPTEMBER',
        batchId: 'B1',
        batchLabel: 'September beans',
        createdAt: new Date(Date.now()).toISOString(),
        undoExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }
    : null,
})

/** A history call the test answers by hand. */
function deferredHistory() {
  let resolve!: (value: { items: HistoryItem[] }) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<{ items: HistoryItem[] }>((res, rej) => {
    resolve = res
    reject = rej
  })
  historyCall.mockReturnValueOnce(promise)
  return { resolve, reject }
}

/** Stands in for the shell's 60-second poll, which is what re-renders every reader. */
const poll = () =>
  act(async () => {
    await coffee.loadMe()
  })

beforeEach(() => {
  me.mockReset()
  historyCall.mockReset()
  coffee.resetCoffeeStore()
  resetHistoryStore()
  me.mockResolvedValue(balance(5))
  historyCall.mockResolvedValue({ items: [row('op1')] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('historyKey', () => {
  const base = {
    memberId: 'M1' as string | null,
    revision: 3,
    totalRemaining: 4,
    undoOpId: 'op1' as string | null,
    // 23:59:59.999 on Friday 25 September in Jakarta.
    now: Date.parse('2026-09-25T16:59:59.999Z'),
  }

  test('holds for a whole Jakarta day and turns over at its midnight', () => {
    const key = historyKey(base)

    // 00:00 on the same Jakarta day, seventeen UTC hours earlier.
    expect(historyKey({ ...base, now: Date.parse('2026-09-24T17:00:00.000Z') })).toBe(key)
    expect(historyKey({ ...base, now: Date.parse('2026-09-25T17:00:00.000Z') })).not.toBe(key)
  })

  test('changes with the member, the revision, the balance and the undo offer', () => {
    const key = historyKey(base)

    // Two members can share every other figure; their ledgers are still not the same page.
    expect(historyKey({ ...base, memberId: 'M2' })).not.toBe(key)
    expect(historyKey({ ...base, memberId: null })).not.toBe(key)
    expect(historyKey({ ...base, revision: 4 })).not.toBe(key)
    expect(historyKey({ ...base, totalRemaining: 5 })).not.toBe(key)
    expect(historyKey({ ...base, totalRemaining: null })).not.toBe(key)
    expect(historyKey({ ...base, undoOpId: 'op2' })).not.toBe(key)
    expect(historyKey({ ...base, undoOpId: null })).not.toBe(key)
  })

  test('never confuses a missing value with one that merely spells it', () => {
    expect(historyKey({ ...base, undoOpId: null })).not.toBe(
      historyKey({ ...base, undoOpId: 'null' }),
    )
  })
})

describe('loadHistory', () => {
  test('asks for a hundred rows under an eight-second deadline and publishes them', async () => {
    await loadHistory('k1')

    expect(HISTORY_LIMIT).toBe(100)
    expect(HISTORY_TIMEOUT_MS).toBe(8_000)
    expect(historyCall).toHaveBeenCalledWith(HISTORY_LIMIT, { timeoutMs: HISTORY_TIMEOUT_MS })
    expect(getHistorySnapshot()).toEqual({
      key: 'k1',
      items: [row('op1')],
      error: null,
      loading: false,
      limit: HISTORY_LIMIT,
    })
  })

  test('one request per key: callers share the one in flight, then its answer', async () => {
    const pending = deferredHistory()

    const first = loadHistory('k1')
    const second = loadHistory('k1')
    expect(historyCall).toHaveBeenCalledTimes(1)
    expect(getHistorySnapshot()).toMatchObject({ items: null, loading: true })

    pending.resolve({ items: [row('op1')] })
    await Promise.all([first, second])
    await loadHistory('k1')

    expect(historyCall).toHaveBeenCalledTimes(1)
    expect(getHistorySnapshot()).toMatchObject({ key: 'k1', items: [row('op1')], loading: false })
  })

  test('force joins a request already in flight but refetches a settled one', async () => {
    const pending = deferredHistory()

    const plain = loadHistory('k1')
    const forced = loadHistory('k1', { force: true })
    expect(historyCall).toHaveBeenCalledTimes(1)
    pending.resolve({ items: [row('op1')] })
    await Promise.all([plain, forced])

    historyCall.mockResolvedValueOnce({ items: [row('op2'), row('op1')] })
    await loadHistory('k1', { force: true })

    expect(historyCall).toHaveBeenCalledTimes(2)
    expect(getHistorySnapshot().items).toEqual([row('op2'), row('op1')])
  })

  test('keeps the rows on screen, flagged as loading, while a new key is fetched', async () => {
    await loadHistory('k1')
    deferredHistory()

    void loadHistory('k2')

    expect(historyCall).toHaveBeenCalledTimes(2)
    expect(getHistorySnapshot()).toEqual({
      key: 'k1',
      items: [row('op1')],
      error: null,
      loading: true,
      limit: HISTORY_LIMIT,
    })
  })

  test('an answer for a key that is no longer the latest is never published', async () => {
    const stale = deferredHistory()
    const fresh = deferredHistory()

    const old = loadHistory('k1')
    const latest = loadHistory('k2')
    stale.resolve({ items: [row('stale')] })
    await old

    expect(getHistorySnapshot()).toMatchObject({ key: null, items: null, loading: true })

    fresh.resolve({ items: [row('fresh')] })
    await latest
    expect(getHistorySnapshot()).toMatchObject({
      key: 'k2',
      items: [row('fresh')],
      loading: false,
    })
  })

  test('a late answer or failure for an old key cannot overwrite the newer one', async () => {
    const stale = deferredHistory()
    const staleFailure = deferredHistory()
    const fresh = deferredHistory()

    const first = loadHistory('k1')
    const second = loadHistory('k2')
    const latest = loadHistory('k3')
    fresh.resolve({ items: [row('fresh')] })
    await latest
    stale.resolve({ items: [row('stale')] })
    staleFailure.reject(new TimeoutError())
    await Promise.all([first, second])

    expect(getHistorySnapshot()).toEqual({
      key: 'k3',
      items: [row('fresh')],
      error: null,
      loading: false,
      limit: HISTORY_LIMIT,
    })
  })

  test('a key that becomes the latest again takes its own request’s answer', async () => {
    const first = deferredHistory()
    const second = deferredHistory()

    const a = loadHistory('k1')
    void loadHistory('k2')
    const again = loadHistory('k1')
    expect(historyCall).toHaveBeenCalledTimes(2)

    second.resolve({ items: [row('k2 rows')] })
    first.resolve({ items: [row('k1 rows')] })
    await Promise.all([a, again])

    expect(getHistorySnapshot()).toMatchObject({ key: 'k1', items: [row('k1 rows')] })
  })

  test('a timeout becomes an error state for that key', async () => {
    historyCall.mockRejectedValueOnce(new TimeoutError())

    await loadHistory('k1')

    const snapshot = getHistorySnapshot()
    expect(snapshot.error).toBeInstanceOf(TimeoutError)
    expect(snapshot).toMatchObject({ key: 'k1', items: null, loading: false })
  })

  test.each([
    ['an API error', new ApiError('RATE_LIMITED', 'Slow down', 429)],
    ['a dropped connection', new OfflineError()],
  ])('%s becomes an error state too', async (_label, error) => {
    historyCall.mockRejectedValueOnce(error)

    await loadHistory('k1')

    expect(getHistorySnapshot()).toMatchObject({ key: 'k1', items: null, error, loading: false })
  })

  test('a failed refresh keeps the rows it already had for the same key', async () => {
    await loadHistory('k1')
    historyCall.mockRejectedValueOnce(new OfflineError())

    await loadHistory('k1', { force: true })

    expect(getHistorySnapshot()).toMatchObject({
      key: 'k1',
      items: [row('op1')],
      error: expect.any(OfflineError),
      loading: false,
    })
  })

  test('a failure for a new key never passes the previous key’s rows off as its own', async () => {
    await loadHistory('k1')
    historyCall.mockRejectedValueOnce(new TimeoutError())

    await loadHistory('k2')

    expect(getHistorySnapshot()).toMatchObject({
      key: 'k2',
      items: null,
      error: expect.any(TimeoutError),
    })
  })

  test('a new attempt clears the last error while it runs, and a failure is not cached', async () => {
    historyCall.mockRejectedValueOnce(new TimeoutError())
    await loadHistory('k1')
    const pending = deferredHistory()

    // Not forced: a screen that mounts later asks again rather than inheriting
    // a failure it never saw happen.
    const retry = loadHistory('k1')

    expect(historyCall).toHaveBeenCalledTimes(2)
    expect(getHistorySnapshot()).toMatchObject({ key: null, items: null, error: null, loading: true })
    pending.resolve({ items: [row('op1')] })
    await retry
    expect(getHistorySnapshot()).toMatchObject({ key: 'k1', items: [row('op1')], error: null })
  })

  test('a request from before a reset never publishes into the fresh store', async () => {
    const pending = deferredHistory()
    const before = loadHistory('k1')

    resetHistoryStore()
    pending.resolve({ items: [row('from the last test')] })
    await before

    expect(getHistorySnapshot()).toEqual({
      key: null,
      items: null,
      error: null,
      loading: false,
      limit: HISTORY_LIMIT,
    })
  })
})

describe('useHistory', () => {
  test('waits for the balance, then asks once for its key', async () => {
    const { result } = renderHook(() => useHistory())

    // History read after /api/me is at least as new as the balance it is keyed on.
    expect(historyCall).not.toHaveBeenCalled()
    expect(result.current).toMatchObject({ items: null, error: null, loading: true })

    await poll()

    await waitFor(() => expect(result.current.items).toEqual([row('op1')]))
    expect(historyCall).toHaveBeenCalledTimes(1)
    expect(result.current).toMatchObject({ error: null, loading: false, limit: HISTORY_LIMIT })
  })

  test('still loads when the balance itself failed', async () => {
    me.mockRejectedValueOnce(new OfflineError())

    const { result } = renderHook(() => useHistory())
    await poll()

    await waitFor(() => expect(result.current.items).toEqual([row('op1')]))
    expect(historyCall).toHaveBeenCalledTimes(1)
  })

  test('every reader on screen shares the one request', async () => {
    await poll()

    const history = renderHook(() => useHistory())
    const sheet = renderHook(() => useHistory())

    await waitFor(() => expect(history.result.current.items).toEqual([row('op1')]))
    expect(sheet.result.current.items).toEqual([row('op1')])
    expect(historyCall).toHaveBeenCalledTimes(1)
  })

  test('a poll that changes nothing does not refetch', async () => {
    await poll()
    const { result } = renderHook(() => useHistory())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await poll()
    await poll()

    expect(me).toHaveBeenCalledTimes(3)
    expect(historyCall).toHaveBeenCalledTimes(1)
  })

  test('refetches when a poll finds a different balance, showing the old rows meanwhile', async () => {
    await poll()
    const { result } = renderHook(() => useHistory())
    await waitFor(() => expect(result.current.loading).toBe(false))
    const pending = deferredHistory()

    // A cup taken on another device.
    me.mockResolvedValue(balance(4))
    await poll()

    expect(historyCall).toHaveBeenCalledTimes(2)
    expect(result.current).toMatchObject({ items: [row('op1')], loading: true })
    await act(async () => pending.resolve({ items: [row('op2'), row('op1')] }))
    expect(result.current).toMatchObject({ items: [row('op2'), row('op1')], loading: false })
  })

  test('refetches when a poll finds the undo offer gone', async () => {
    me.mockResolvedValue(balance(4, 'op1'))
    await poll()
    const { result } = renderHook(() => useHistory())
    await waitFor(() => expect(result.current.loading).toBe(false))

    // Put back on another device: the same op, now reversed, leaves the offer
    // and the balance where a stale key could not see the change.
    me.mockResolvedValue(balance(5, null))
    historyCall.mockResolvedValueOnce({ items: [row('op1', { reversed: true })] })
    await poll()

    await waitFor(() => expect(result.current.items).toEqual([row('op1', { reversed: true })]))
    expect(historyCall).toHaveBeenCalledTimes(2)
  })

  test('refetches when the undo offer moves to another op at the same balance', async () => {
    me.mockResolvedValue(balance(4, 'op1'))
    await poll()
    const { result } = renderHook(() => useHistory())
    await waitFor(() => expect(result.current.loading).toBe(false))

    me.mockResolvedValue(balance(4, 'op2'))
    await poll()

    await waitFor(() => expect(historyCall).toHaveBeenCalledTimes(2))
  })

  test('refetches once the Jakarta day turns over, on the next poll, with no timer of its own', async () => {
    // Only Date is faked, so Testing Library's waitFor keeps its real timers.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-25T16:59:00.000Z')) // 23:59 in Jakarta
    await poll()
    const { result } = renderHook(() => useHistory())
    await waitFor(() => expect(result.current.loading).toBe(false))

    vi.setSystemTime(new Date('2026-09-25T17:00:00.000Z')) // 00:00, a new Jakarta day
    expect(historyCall).toHaveBeenCalledTimes(1)

    await poll()

    await waitFor(() => expect(historyCall).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.loading).toBe(false))
  })

  test('refresh() refetches the current key even though it has an answer', async () => {
    await poll()
    const { result } = renderHook(() => useHistory())
    await waitFor(() => expect(result.current.loading).toBe(false))
    historyCall.mockResolvedValueOnce({ items: [row('op2'), row('op1')] })

    act(() => result.current.refresh())

    await waitFor(() => expect(result.current.items).toEqual([row('op2'), row('op1')]))
    expect(historyCall).toHaveBeenCalledTimes(2)
  })

  test('a timeout reaches the reader as an error, and refresh() recovers', async () => {
    historyCall.mockRejectedValueOnce(new TimeoutError())
    await poll()
    const { result } = renderHook(() => useHistory())

    await waitFor(() => expect(result.current.error).toBeInstanceOf(TimeoutError))
    expect(result.current).toMatchObject({ items: null, loading: false })

    act(() => result.current.refresh())

    await waitFor(() => expect(result.current.items).toEqual([row('op1')]))
    expect(result.current.error).toBeNull()
  })

  test('asks once under <StrictMode>, whose rehearsal mount runs the effect twice', async () => {
    await poll()

    const { result } = renderHook(() => useHistory(), { wrapper: StrictMode })

    await waitFor(() => expect(result.current.items).toEqual([row('op1')]))
    expect(historyCall).toHaveBeenCalledTimes(1)
  })

  test('never shows one member the ledger of another who had the same balance', async () => {
    await poll()
    const { result } = renderHook(() => useHistory())
    await waitFor(() => expect(result.current.items).toEqual([row('op1')]))
    const pending = deferredHistory()

    // Signed out and back in as someone else, or a QA session redeemed over a
    // real one, in the same tab: nothing module-level is reset, and every
    // other part of the key can coincide.
    me.mockResolvedValue(balance(5, null, 'M2'))
    await poll()

    expect(historyCall).toHaveBeenCalledTimes(2)
    // The rows on screen while the new page loads are M1's, so they go.
    expect(result.current).toMatchObject({ key: null, items: null, error: null, loading: true })
    await act(async () => pending.resolve({ items: [row('theirs')] }))
    expect(result.current).toMatchObject({ items: [row('theirs')], loading: false })
  })

  test('a disabled reader is shown nothing, even while another reader has the page', async () => {
    await poll()
    const shown = renderHook(() => useHistory())
    await waitFor(() => expect(shown.result.current.items).toEqual([row('op1')]))

    const hidden = renderHook(() => useHistory({ enabled: false }))

    // It asked for nothing, so it has no rows it could vouch for.
    expect(hidden.result.current).toMatchObject({ key: null, items: null, error: null, loading: false })
  })

  test('asks for nothing while disabled, and loads once enabled', async () => {
    await poll()
    const { result, rerender } = renderHook(({ enabled }) => useHistory({ enabled }), {
      initialProps: { enabled: false },
    })

    await poll()
    expect(historyCall).not.toHaveBeenCalled()

    rerender({ enabled: true })
    await waitFor(() => expect(result.current.items).toEqual([row('op1')]))
    expect(historyCall).toHaveBeenCalledTimes(1)
  })
})
