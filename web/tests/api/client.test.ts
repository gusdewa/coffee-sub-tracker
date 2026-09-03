import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../../src/auth/firebase', () => ({ currentIdToken: vi.fn().mockResolvedValue(null) }))

const fetchCall = vi.fn()
vi.stubGlobal('fetch', fetchCall)

const { api } = await import('../../src/api/client')

beforeEach(() => {
  fetchCall.mockReset()
  fetchCall.mockResolvedValue(
    new Response(JSON.stringify({ balances: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
})

describe('API reads', () => {
  test.each([
    ['the member balance', () => api.me()],
    ['the team recap balances', () => api.balances()],
  ])('does not allow browser caching for %s', async (_label, request) => {
    await request()

    expect(fetchCall).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cache: 'no-store' }),
    )
  })
})
