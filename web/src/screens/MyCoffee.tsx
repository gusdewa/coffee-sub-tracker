import { useEffect } from 'react'
import { useCoffee, loadMe } from '../state/coffee'
import { PunchCard } from '../components/PunchCard'
import { Skeleton } from '../components/Skeleton'
import { ErrorState } from '../components/ErrorState'

/**
 * How many cups are left, and which card the next one comes off.
 *
 * The action that spends one used to live here, which is why it only existed on
 * this route and why its 90-second undo died the moment you navigated away.
 * Both now belong to the shell; this screen is the picture of the balance.
 */
export function MyCoffee() {
  const { data, error } = useCoffee()

  useEffect(() => {
    if (!data) void loadMe()
  }, [data])

  if (!data && !error) return <Skeleton />
  if (!data) return <ErrorState error={error!} onRetry={() => void loadMe()} />

  const empty = data.totalRemaining === 0
  /*
   * Both the marker and the index are computed over the *same* list. They were
   * not: the index came from the unfiltered allocations while the cards
   * rendered a filtered copy, so a fully-granted-but-empty batch ahead of the
   * FIFO head slid the two apart and the "next" badge landed on the wrong card.
   */
  const cards = data.allocations.filter((a) => a.granted > 0)
  const nextIndex = cards.findIndex((a) => a.remaining > 0)

  return (
    <div className="screen">
      <div className="hero" data-tour="balance">
        <span className="hero__number tabular">{data.totalRemaining}</span>
        <span className="hero__unit">{data.totalRemaining === 1 ? 'cup left' : 'cups left'}</span>
      </div>

      {empty ? (
        <p className="empty">
          Nothing left on any card. Ask an admin to add a subscription.
        </p>
      ) : (
        <div className="cards">
          {cards.map((a, i) => (
            <PunchCard key={a.batchId + a.effectiveAt} allocation={a} isNext={i === nextIndex} />
          ))}
        </div>
      )}
    </div>
  )
}
