import { describe, test, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ErrorState } from '../../src/components/ErrorState'
import * as client from '../../src/api/client'

const { OfflineError } = client

/**
 * The copy decides whether someone at the machine taps again. A Drink whose
 * answer never arrived may already be counted, so it must not reuse the
 * offline line that promises it was not.
 */
describe('ErrorState copy', () => {
  test('a timed-out read says it took too long', () => {
    render(<ErrorState error={new client.TimeoutError()} onRetry={vi.fn()} />)

    expect(screen.getByRole('alert')).toHaveTextContent('That took too long. Try again.')
  })

  test('an unconfirmed Drink sends the person to their balance, not to tap again', () => {
    render(<ErrorState error={new client.UnconfirmedDrinkError()} onRetry={vi.fn()} inline />)

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(
      "Couldn't confirm your cup. Check your balance before tapping again.",
    )
    expect(alert).not.toHaveTextContent(/not counted/i)
  })

  test('a refused offline Drink keeps its old copy', () => {
    render(<ErrorState error={new OfflineError()} onRetry={vi.fn()} inline />)

    expect(screen.getByRole('alert')).toHaveTextContent('No connection. Your cup was not counted.')
  })

  test('the new errors are recognisable by code, like OfflineError', () => {
    expect(new client.TimeoutError()).toMatchObject({ name: 'TimeoutError', code: 'TIMEOUT' })
    expect(new client.UnconfirmedDrinkError()).toMatchObject({
      name: 'UnconfirmedDrinkError',
      code: 'DRINK_UNCONFIRMED',
    })
  })
})
