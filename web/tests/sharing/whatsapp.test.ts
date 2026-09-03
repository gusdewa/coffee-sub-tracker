import { describe, expect, test } from 'vitest'
import { formatCoffeeRecap, whatsAppShareUrl } from '../../src/sharing/whatsapp'

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

    expect(message).toContain('Dewa Wijaya drank 1 cup')
    expect(message).toContain('September beans')
    expect(message).toContain('Dewa Wijaya: 4 cups')
    expect(message).toContain('Ayu: 1 cup')
    expect(message).toContain('Current balances:')
  })

  test('discloses when only a partial balance recap is available', () => {
    const message = formatCoffeeRecap({ ...recap, balanceState: 'partial' })

    expect(message).toContain('Full balance list unavailable.')
    expect(message).toContain('Known balance:')
    expect(message).not.toContain('Current balances:')
  })

  test('uses wa.me with the complete recap URL-encoded', () => {
    const message = formatCoffeeRecap(recap)
    expect(whatsAppShareUrl(message)).toBe(`https://wa.me/?text=${encodeURIComponent(message)}`)
  })
})