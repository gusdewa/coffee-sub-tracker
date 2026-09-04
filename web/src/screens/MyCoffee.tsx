import { useEffect } from 'react'
import { useCoffee, loadMe, undoDrink } from '../state/coffee'
import { PunchCard } from '../components/PunchCard'
import { Skeleton } from '../components/Skeleton'
import { ErrorState } from '../components/ErrorState'

/**
 * Home answers three questions, in this order:
 *
 *   1. How many cups are left?
 *   2. Which card will the next one come off?
 *   3. What can I do now?
 *
 * One dominant composition rather than a grid of equal-weight tiles, because
 * only the first question is asked every day. The third is the floating action
 * in the shell — a second large Drink button here would only compete with it.
 *
 * The counter slip borrows the dock's perforated edge, so the page and the
 * shell read as one object: a card you punch.
 */
export function MyCoffee() {
  const { data, error, undo, busy } = useCoffee()

  useEffect(() => {
    if (!data) void loadMe()
  }, [data])

  if (!data && !error) return <Skeleton />
  if (!data) return <ErrorState error={error!} onRetry={() => void loadMe()} />

  const empty = data.totalRemaining === 0
  /*
   * The marker and the index are computed over the *same* list. They were not:
   * the index came from the unfiltered allocations while the cards rendered a
   * filtered copy, so a fully-granted-but-empty batch ahead of the FIFO head
   * slid the two apart and the badge landed on the wrong card.
   */
  const cards = data.allocations.filter((a) => a.granted > 0)
  const nextIndex = cards.findIndex((a) => a.remaining > 0)
  const next = nextIndex >= 0 ? cards[nextIndex] : undefined

  return (
    <div className="screen">
      <section className="slip" data-tour="balance" aria-label="Your balance">
        <p className="slip__count">
          <span className="slip__number tabular">{data.totalRemaining}</span>
          <span className="slip__unit">
            {data.totalRemaining === 1 ? 'cup left' : 'cups left'}
          </span>
        </p>

        <div className="slip__tear" aria-hidden="true" />

        {next ? (
          <p className="slip__next">
            Next cup from <strong>{next.batchLabel || 'your oldest card'}</strong>
          </p>
        ) : (
          <p className="slip__next slip__next--empty">
            Nothing left on any card. Ask an admin to add a subscription.
          </p>
        )}
      </section>

      {cards.length > 0 && (
        <section className="home__cards">
          <h2 className="home__heading">Your cards</h2>
          <div className="cards">
            {cards.map((a, i) => (
              <PunchCard
                key={a.allocRowKey || a.batchId}
                allocation={a}
                isNext={i === nextIndex}
                canPutBack={Boolean(undo && (undo.allocRowKey
                  ? undo.allocRowKey === a.allocRowKey
                  : undo.batchId === a.batchId))}
                putBackBusy={busy}
                onPutBack={() => void undoDrink()}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
