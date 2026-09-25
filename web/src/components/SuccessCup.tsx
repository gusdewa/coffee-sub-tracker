/**
 * The cup at the top of the post-Drink summary.
 *
 * Drawn from CoffeeCupIcon's own shapes, scaled up, so the success moment is
 * visibly the same cup as the Drink button that caused it. What it adds is the
 * card's language: the body is filled and a hole is punched through it, the
 * way a cup comes off a punch card.
 *
 * Every part carries a class so a stylesheet can animate it, and the base
 * styles draw the *final* frame: with motion reduced, or before any keyframes
 * exist, the picture is complete and still. The steam uses pathLength="1" (only
 * valid on <path>) so it can be drawn in with stroke-dashoffset whatever its
 * real length.
 *
 * Decorative: `Drink 1` beside it says everything it does.
 */
export function SuccessCup() {
  return (
    <svg
      className="success-cup"
      viewBox="0 0 64 64"
      width="64"
      height="64"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* CoffeeCupIcon's 24-unit geometry, centred at 2.4x. */}
      <g transform="translate(3.5 5.5) scale(2.4)" strokeWidth="1.6">
        <path d="M4.9 9.6h11.2v3.9a5.6 5.6 0 0 1-11.2 0V9.6Z" fill="currentColor" />
        <path d="M16.1 10.8h1.6a2.4 2.4 0 0 1 0 4.8h-1.6" />
        <path d="M3.6 20.2h13.8" />
        {/* Drawn from the cup upwards, so steam rises when it animates in. */}
        <path className="success-cup__steam" pathLength="1" d="M8 6.3c-.75-.95-.75-1.95 0-2.9" />
        <path className="success-cup__steam" pathLength="1" d="M11.6 6.3c-.75-.95-.75-1.95 0-2.9" />
        {/* Painted in the sheet's own paper, so it reads as a hole, not a dot. */}
        <circle
          className="success-cup__hole"
          cx="10.5"
          cy="13.4"
          r="1.5"
          fill="var(--paper-raised)"
          stroke="none"
        />
      </g>
      <g strokeWidth="2.6">
        <path className="success-cup__spark" d="M49 15.5l3.2-3.2" />
        <path className="success-cup__spark" d="M53 25h4.4" />
        <path className="success-cup__spark" d="M42.5 9.5l.8-4.3" />
      </g>
    </svg>
  )
}
