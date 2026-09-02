import { describe, test, expect, beforeEach } from 'vitest'
import {
  beginMutation,
  endMutation,
  isMutating,
  onMutationChange,
  withMutationGuard,
  resetMutationGuard,
} from '../../src/pwa/mutationGuard'

/**
 * An update must never reload over an in-flight drink.
 *
 * The server would not double count — the idempotency key sees to that — but
 * the person would be left looking at a balance they cannot account for, which
 * is the same problem from where they are standing.
 */

beforeEach(() => resetMutationGuard())

describe('mutation guard', () => {
  test('is idle until something is in flight', () => {
    expect(isMutating()).toBe(false)
  })

  test('stays busy until the LAST overlapping mutation finishes', () => {
    beginMutation()
    beginMutation()
    endMutation()
    // A boolean would have lifted here, and a reload could land on the second.
    expect(isMutating()).toBe(true)
    endMutation()
    expect(isMutating()).toBe(false)
  })

  test('never goes negative', () => {
    endMutation()
    endMutation()
    expect(isMutating()).toBe(false)
    beginMutation()
    // A counter stuck below zero would silently disable the guard for good.
    expect(isMutating()).toBe(true)
  })

  test('notifies subscribers on both edges', () => {
    const seen: boolean[] = []
    onMutationChange((busy) => seen.push(busy))
    beginMutation()
    endMutation()
    expect(seen).toEqual([true, false])
  })

  test('unsubscribing stops notifications', () => {
    const seen: boolean[] = []
    const off = onMutationChange((busy) => seen.push(busy))
    off()
    beginMutation()
    expect(seen).toEqual([])
  })

  test('withMutationGuard releases on success', async () => {
    const result = await withMutationGuard(async () => 'ok')
    expect(result).toBe('ok')
    expect(isMutating()).toBe(false)
  })

  test('withMutationGuard releases on FAILURE', async () => {
    // The one that matters: without `finally`, a single network error would
    // block every future update for the rest of the session.
    await expect(
      withMutationGuard(async () => {
        throw new Error('network')
      }),
    ).rejects.toThrow('network')
    expect(isMutating()).toBe(false)
  })

  test('is busy while the call is still pending', async () => {
    let release: (v: unknown) => void = () => {}
    const pending = withMutationGuard(() => new Promise((r) => (release = r)))
    expect(isMutating()).toBe(true)
    release(null)
    await pending
    expect(isMutating()).toBe(false)
  })
})
