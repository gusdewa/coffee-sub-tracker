import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

/**
 * When a deploy is actually noticed.
 *
 * Note: no `waitFor` in this file. It polls on real timers, which deadlocks
 * against the fake timers these tests need in order to exercise the periodic
 * check — the symptom is a 5s timeout, not an assertion failure.
 *
 * An installed PWA is rarely closed, so "on startup" alone means a phone can
 * run a stale build for days. These are the moments it is most likely to have
 * missed one: returning to the tab, returning online, and simply having been
 * open a long while.
 */

const registration = { update: vi.fn().mockResolvedValue(undefined) }
let onNeedRefresh: (() => void) | undefined

vi.mock('virtual:pwa-register', () => ({
  registerSW: (opts: {
    onNeedRefresh?: () => void
    onRegistered?: (r: unknown) => void
  }) => {
    onNeedRefresh = opts.onNeedRefresh
    opts.onRegistered?.(registration)
    return vi.fn().mockResolvedValue(undefined)
  },
}))

const controllerListeners: Array<() => void> = []

beforeEach(() => {
  vi.useFakeTimers()
  registration.update.mockClear()
  controllerListeners.length = 0
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      addEventListener: (type: string, fn: () => void) => {
        if (type === 'controllerchange') controllerListeners.push(fn)
      },
      removeEventListener: () => {},
    },
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.resetModules()
})

/** Let promises settle without handing control to real timers. */
async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

async function mount() {
  const { useServiceWorker, resetReloadLatch } = await import('../../src/pwa/useServiceWorker')
  resetReloadLatch()
  const view = renderHook(() => useServiceWorker())
  // Let the dynamic import of the virtual module settle.
  await flush()
  return view
}

describe('update checks', () => {
  test('checks again when the tab becomes visible', async () => {
    await mount()
    registration.update.mockClear()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await flush()
    expect(registration.update).toHaveBeenCalled()
  })

  test('does not check while the tab is hidden', async () => {
    await mount()
    registration.update.mockClear()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(registration.update).not.toHaveBeenCalled()
  })

  test('checks when the connection returns', async () => {
    await mount()
    registration.update.mockClear()
    act(() => {
      window.dispatchEvent(new Event('online'))
    })
    await flush()
    expect(registration.update).toHaveBeenCalled()
  })

  test('checks periodically while the tab stays open', async () => {
    await mount()
    registration.update.mockClear()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 100)
    })
    expect(registration.update).toHaveBeenCalled()
  })

  test('stops checking once unmounted', async () => {
    const view = await mount()
    view.unmount()
    registration.update.mockClear()
    act(() => {
      window.dispatchEvent(new Event('online'))
    })
    expect(registration.update).not.toHaveBeenCalled()
  })
})

describe('a waiting build surfaces', () => {
  test('needsRefresh flips when the plugin reports one', async () => {
    const view = await mount()
    expect(view.result.current.needsRefresh).toBe(false)
    act(() => onNeedRefresh?.())
    await flush()
    expect(view.result.current.needsRefresh).toBe(true)
  })
})

describe('controllerchange', () => {
  test('a tab that did not ask is offered a reload rather than being reloaded', async () => {
    const view = await mount()
    expect(controllerListeners.length).toBeGreaterThan(0)
    act(() => controllerListeners.forEach((fn) => fn()))
    await flush()
    // Never yanked out from under whatever the person was doing.
    expect(view.result.current.updatedElsewhere).toBe(true)
  })
})
