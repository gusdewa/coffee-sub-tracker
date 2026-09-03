/**
 * The product mark: a cup, and the card it comes off.
 *
 * Inline SVG, drawn from the same tokens as the rest of the app, so it costs no
 * request and is correct in both colour schemes. It is compact on purpose — the
 * brief for this screen is to introduce the product without pushing the one
 * button anybody came for below the fold.
 */
export function CoffeeMark() {
  return (
    <svg
      className="login__mark"
      aria-hidden="true"
      viewBox="0 0 160 132"
      fill="none"
      role="presentation"
    >
      {/* steam */}
      <g stroke="var(--punch)" strokeWidth="3" strokeLinecap="round" opacity="0.75">
        <path d="M69 22c-5-6 5-11 0-17" />
        <path d="M83 22c-5-6 5-11 0-17" />
      </g>

      {/* cup */}
      <path d="M56 32h40v14a20 20 0 0 1-40 0V32Z" fill="var(--action)" />
      <path
        d="M96 36h5a9 9 0 0 1 0 18h-5"
        stroke="var(--action)"
        strokeWidth="3.5"
        strokeLinecap="round"
      />
      <path
        d="M48 70h56"
        stroke="var(--ink-soft)"
        strokeWidth="3"
        strokeLinecap="round"
        opacity="0.5"
      />

      {/* the card it comes off */}
      <rect
        x="24"
        y="84"
        width="112"
        height="40"
        rx="8"
        fill="var(--paper-raised)"
        stroke="var(--paper-edge)"
        strokeWidth="2"
      />
      {/* perforated top edge, the same language as the dock */}
      <g fill="var(--paper)">
        {[34, 46, 58, 70, 82, 94, 106, 118, 130].map((cx) => (
          <circle key={cx} cx={cx} cy="84" r="2.5" />
        ))}
      </g>
      {/* three punched, two still to go */}
      <g>
        {[48, 66, 84].map((cx) => (
          <circle key={cx} cx={cx} cy="106" r="5.5" fill="var(--punch)" />
        ))}
        {[102, 120].map((cx) => (
          <circle
            key={cx}
            cx={cx}
            cy="106"
            r="5.5"
            fill="none"
            stroke="var(--spent)"
            strokeWidth="2"
          />
        ))}
      </g>
    </svg>
  )
}

/** The Google G, as published for the sign-in button. */
export function GoogleMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 48 48" width="20" height="20">
      <path
        fill="#4285F4"
        d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"
      />
      <path
        fill="#34A853"
        d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"
      />
      <path
        fill="#FBBC05"
        d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z"
      />
      <path
        fill="#EA4335"
        d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"
      />
    </svg>
  )
}
