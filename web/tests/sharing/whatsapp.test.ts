import { describe, expect, test } from 'vitest'
import {
  buildShareMessage,
  formatCoffeeRecap,
  whatsAppShareUrl,
  type TeamState,
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

  test('keeps the complete recap in the exact shape the team group reads', () => {
    expect(formatCoffeeRecap(recap)).toBe(
      'Cart Coffee\n' +
        'Dewa Wijaya drank 1 cup from September beans.\n' +
        '\n' +
        'Current balances:\n' +
        'Dewa Wijaya: 4 cups\n' +
        'Ayu: 1 cup\n' +
        'Total remaining: 5 cups',
    )
  })

  test('discloses when only a partial balance recap is available', () => {
    const message = formatCoffeeRecap({ ...recap, balanceState: 'partial' })

    expect(message).toContain('Team balances not included.')
    expect(message).not.toContain('Full balance list unavailable.')
    expect(message).toContain('Dewa Wijaya: 4 cups')
    expect(message).not.toContain('Current balances:')
    expect(message).not.toContain('Total remaining:')
  })

  test('labels the self-only row as a balance so "4 cups" cannot read as cups drunk', () => {
    const selfOnly = {
      ...recap,
      balances: [{ memberId: 'M1', displayName: 'Dewa Wijaya', remaining: 4 }],
      balanceState: 'partial' as const,
    }

    expect(formatCoffeeRecap(selfOnly)).toBe(
      'Cart Coffee\n' +
        'Dewa Wijaya drank 1 cup from September beans.\n' +
        '\n' +
        'Team balances not included.\n' +
        'Known balance:\n' +
        'Dewa Wijaya: 4 cups',
    )
  })

  test.each([
    ['empty', ''],
    ['blank', '   '],
    ['null', null],
    // Old API responses may omit the label entirely.
    ['missing', undefined],
  ])('drops the source clause when the batch label is %s', (_label, batchLabel) => {
    const message = formatCoffeeRecap({ ...recap, batchLabel })

    expect(message).toContain('\nDewa Wijaya drank 1 cup.\n')
    // The group reads this in the third person: "from your card" would claim
    // the drink came from the reader's card, and "from ." is a broken sentence.
    expect(message).not.toContain('from')
    expect(message).not.toContain('your card')
  })

  test('uses wa.me with the complete recap URL-encoded', () => {
    const message = formatCoffeeRecap(recap)
    expect(whatsAppShareUrl(message)).toBe(`https://wa.me/?text=${encodeURIComponent(message)}`)
  })
})

describe('building the Share to WhatsApp message', () => {
  // The drinker's row (5) predates the Drink; live state says 4.
  const rows = [
    { memberId: 'M1', displayName: 'Dewa Wijaya', remaining: 5 },
    { memberId: 'M2', displayName: 'Ayu', remaining: 1 },
    { memberId: 'M3', displayName: 'Budi', remaining: 3 },
  ]
  const team: TeamState = { status: 'ready', rows }
  const input = {
    memberName: 'Dewa Wijaya',
    memberId: 'M1',
    batchLabel: 'September beans',
    liveRemaining: 4,
    team,
  }

  test('with the full team list: current balances, the total and how many people', () => {
    const share = buildShareMessage(input)

    expect(share.balanceState).toBe('complete')
    expect(share.message).toContain('Dewa Wijaya drank 1 cup from September beans.')
    expect(share.message).toContain('Current balances:')
    expect(share.message).toContain('Ayu: 1 cup')
    expect(share.message).toContain('Budi: 3 cups')
    expect(share.message).toContain('Total remaining: 8 cups')
    expect(share.message).not.toContain('Team balances not included.')
    expect(share.disclosure).toBe('Includes team balances for 3 people')
  })

  test('uses the drinker\'s live number, not the stale balances row', () => {
    const share = buildShareMessage(input)

    expect(share.message).toContain('Dewa Wijaya: 4 cups')
    expect(share.message).not.toContain('Dewa Wijaya: 5 cups')
    // Replaced in place, not appended: the drinker appears exactly once.
    expect(share.message.match(/Dewa Wijaya: /g)).toHaveLength(1)
    expect(share.message.indexOf('Dewa Wijaya: 4 cups')).toBeLessThan(share.message.indexOf('Ayu: 1 cup'))
  })

  test('adds the drinker from live state when /api/balances filtered them out', () => {
    const share = buildShareMessage({
      ...input,
      memberName: 'QA Tester',
      memberId: 'QA1',
      liveRemaining: 2,
    })

    expect(share.balanceState).toBe('complete')
    expect(share.message).toContain('QA Tester: 2 cups')
    expect(share.message).toContain('Dewa Wijaya: 5 cups')
    expect(share.message).toContain('Total remaining: 11 cups')
    expect(share.disclosure).toBe('Includes team balances for 4 people')
  })

  test('says "person" when the merged list holds one row', () => {
    const share = buildShareMessage({ ...input, team: { status: 'ready', rows: [] } })

    expect(share.message).toContain('Dewa Wijaya: 4 cups')
    expect(share.message).toContain('Total remaining: 4 cups')
    expect(share.disclosure).toBe('Includes team balances for 1 person')
  })

  test('while team balances are loading: self-only, and the caption says so', () => {
    const share = buildShareMessage({ ...input, team: { status: 'loading' } })

    expect(share.balanceState).toBe('partial')
    expect(share.disclosure).toBe('Shares your balance only (team balances still loading)')
    expect(share.message).toContain('Team balances not included.')
    expect(share.message).toContain('Dewa Wijaya: 4 cups')
    expect(share.message).not.toContain('Ayu')
    expect(share.message).not.toContain('Current balances:')
    expect(share.message).not.toContain('Total remaining:')
  })

  test.each(['timeout', 'error'] as const)(
    'when team balances are unavailable (%s): self-only with the unavailable caption',
    (reason) => {
      const share = buildShareMessage({ ...input, team: { status: 'unavailable', reason } })

      expect(share.balanceState).toBe('partial')
      expect(share.disclosure).toBe('Team balances unavailable — shares your balance only')
      expect(share.message).toContain('Team balances not included.')
      expect(share.message).toContain('Dewa Wijaya: 4 cups')
      expect(share.message).not.toContain('Ayu')
    },
  )

  test('the url is wa.me with exactly the message, round-tripping emoji and newlines', () => {
    const share = buildShareMessage({
      ...input,
      memberName: 'Dewa ☕️',
      batchLabel: 'Kopi Susu 🥛 batch',
    })
    const prefix = 'https://wa.me/?text='

    expect(share.url).toBe(`${prefix}${encodeURIComponent(share.message)}`)
    expect(share.url).toBe(whatsAppShareUrl(share.message))
    expect(share.url).not.toMatch(/\s/)
    const decoded = decodeURIComponent(share.url.slice(prefix.length))
    expect(decoded).toBe(share.message)
    expect(decoded).toContain('Dewa ☕️ drank 1 cup from Kopi Susu 🥛 batch.')
    expect(decoded.split('\n').length).toBeGreaterThan(3)
  })

  test('an empty batch label leaves the source out rather than inventing one', () => {
    const share = buildShareMessage({ ...input, batchLabel: '' })

    expect(share.message).toContain('\nDewa Wijaya drank 1 cup.\n')
    expect(share.message).not.toContain('from .')
    expect(share.message).not.toContain('your card')
  })

  const balanceLines = (message: string) =>
    message
      .split('\n')
      .filter((line) => /^.+: \d+ cups?$/.test(line) && !line.startsWith('Total remaining:'))

  test.each<[string, TeamState]>([
    ['ready', team],
    ['ready without the drinker', { status: 'ready', rows: rows.slice(1) }],
    ['ready with the drinker twice', { status: 'ready', rows: [...rows, rows[0]!] }],
    ['loading', { status: 'loading' }],
    ['timed out', { status: 'unavailable', reason: 'timeout' }],
    ['errored', { status: 'unavailable', reason: 'error' }],
  ])('the caption promises exactly what the message carries (%s)', (_label, teamState) => {
    const share = buildShareMessage({ ...input, team: teamState })
    const lines = balanceLines(share.message)
    const promised = /^Includes team balances for (\d+) (?:person|people)$/.exec(share.disclosure)

    // The drinker is always present exactly once, with the live number.
    expect(lines.filter((line) => line.startsWith('Dewa Wijaya: '))).toEqual(['Dewa Wijaya: 4 cups'])
    if (promised) {
      expect(share.balanceState).toBe('complete')
      expect(lines).toHaveLength(Number(promised[1]))
      expect(share.message).toContain('Current balances:')
      expect(share.message).not.toContain('Team balances not included.')
    } else {
      expect(share.balanceState).toBe('partial')
      expect(share.disclosure).toMatch(/your balance only/)
      expect(lines).toEqual(['Dewa Wijaya: 4 cups'])
      expect(share.message).toContain('Team balances not included.')
      expect(share.message).not.toContain('Total remaining:')
    }
  })
})
