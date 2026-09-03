import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest'
import {
  WHATSAPP_HANDOFF_WINDOW_NAME,
  formatCoffeeRecap,
  reserveWhatsAppHandoffWindow,
  whatsAppShareUrl,
} from '../../src/sharing/whatsapp'

const recap = {
  memberName: 'Dewa Wijaya',
  batchLabel: 'September beans',
  balances: [
    { memberId: 'M1', displayName: 'Dewa Wijaya', remaining: 4 },
    { memberId: 'M2', displayName: 'Ayu', remaining: 1 },
  ],
}

describe('the WhatsApp coffee recap', () => {
  test('truthfully names the drink, batch, and every returned balance', () => {
    const message = formatCoffeeRecap(recap)

    expect(message.startsWith('Cart Coffee\n')).toBe(true)
    expect(message).toContain('Dewa Wijaya drank 1 cup')
    expect(message).toContain('September beans')
    expect(message).toContain('Dewa Wijaya: 4 cups')
    expect(message).toContain('Ayu: 1 cup')
    expect(message).toContain('Current balances:')
    expect(message).toContain('Total remaining: 5 cups')
  })

  test('discloses when only a partial balance recap is available', () => {
    const message = formatCoffeeRecap({ ...recap, balanceState: 'partial' })

    expect(message).toContain('Full balance list unavailable.')
    expect(message).toContain('Known balance:')
    expect(message).not.toContain('Current balances:')
    expect(message).not.toContain('Total remaining:')
  })

  test('uses wa.me with the complete recap URL-encoded', () => {
    const message = formatCoffeeRecap(recap)
    expect(whatsAppShareUrl(message)).toBe(`https://wa.me/?text=${encodeURIComponent(message)}`)
  })
})

describe('reserving the WhatsApp handoff context', () => {
  const fakeWindow = () => ({
    opener: window,
    location: { assign: vi.fn() },
    close: vi.fn(),
  })

  beforeEach(() => {
    vi.spyOn(window, 'open')
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('opens one named context synchronously and severs its opener', () => {
    const win = fakeWindow()
    vi.mocked(window.open).mockReturnValue(win as unknown as Window & typeof globalThis)

    const reserved = reserveWhatsAppHandoffWindow()

    expect(window.open).toHaveBeenCalledTimes(1)
    expect(window.open).toHaveBeenCalledWith('', WHATSAPP_HANDOFF_WINDOW_NAME)
    expect(WHATSAPP_HANDOFF_WINDOW_NAME).toBe('coffee-sub-wa-handoff')
    expect(win.opener).toBeNull()
    expect(reserved).not.toBeNull()
  })

  test('navigates the reserved context to the recap URL on demand', () => {
    const win = fakeWindow()
    vi.mocked(window.open).mockReturnValue(win as unknown as Window & typeof globalThis)
    const reserved = reserveWhatsAppHandoffWindow()

    expect(reserved!.navigate('https://wa.me/?text=Cart%20Coffee')).toBe(true)
    expect(win.location.assign).toHaveBeenCalledTimes(1)
    expect(win.location.assign).toHaveBeenCalledWith('https://wa.me/?text=Cart%20Coffee')
  })

  test('closing the reservation reclaims the context', () => {
    const win = fakeWindow()
    vi.mocked(window.open).mockReturnValue(win as unknown as Window & typeof globalThis)
    const reserved = reserveWhatsAppHandoffWindow()

    reserved!.close()
    expect(win.close).toHaveBeenCalledTimes(1)
  })

  test('a blocked reservation reports null rather than throwing', () => {
    vi.mocked(window.open).mockReturnValue(null)
    expect(reserveWhatsAppHandoffWindow()).toBeNull()

    vi.mocked(window.open).mockImplementation(() => {
      throw new Error('popup blocked')
    })
    expect(reserveWhatsAppHandoffWindow()).toBeNull()
  })

  test('a vanished context is reported, not thrown from, on navigate and close', () => {
    const win = {
      opener: window,
      location: {
        assign: () => {
          throw new Error('cross-origin or closed')
        },
      },
      close: () => {
        throw new Error('already gone')
      },
    }
    vi.mocked(window.open).mockReturnValue(win as unknown as Window & typeof globalThis)

    const reserved = reserveWhatsAppHandoffWindow()
    expect(reserved).not.toBeNull()
    expect(reserved!.navigate('https://wa.me/')).toBe(false)
    expect(() => reserved!.close()).not.toThrow()
  })
})
