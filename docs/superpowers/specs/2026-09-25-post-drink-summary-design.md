# Post-Drink Summary Sheet Design

Supersedes `2026-09-03-drink-whatsapp-design.md` and its plan. The API is
unchanged; the web app adds one read, `GET /api/me/history?limit=100`.

## Root cause

Tapping Drink called `window.open('', 'coffee-sub-wa-handoff')` inside the tap,
*before* the cup was recorded, then waited on `drink()`, a double-rAF paint
barrier and `api.balances()` before sending that window to `wa.me`. On a phone
the reserved tab comes to the front and hides the app; a hidden page runs no
rAF, so the wait stalls and the person is left on `about:blank`. A hanging
balances or Drink request did the same on every browser, since no read had a
timeout. Headless and headed Playwright keep every page "visible", which is why
the e2e suite never saw it.

Alongside it: the card's Put Back sat under the Drink button at 320×568, the
success snackbar's live region could miss its announcement, "Drink another?"
painted beneath the update prompt, the empty hero "0" was ~1.8:1, the retry
button was ~36px tall, and the tour and README still promised "10 seconds".

## Decisions

- **No automatic navigation, ever.** A Drink never opens, reserves or navigates
  a window. `tests/sharing/no-auto-navigation.test.ts` forbids `window.open(`,
  `location.assign/replace(`, `location.href =` and `'_self'` in `src/`.
- **A summary sheet instead.** On success the store publishes, in one update,
  the patched balance, the undo offer, `revision + 1` and a `receipt`. A native
  `<dialog>` sheet (`Sheet.tsx`, top layer, focus trap, inert page) opens headed
  **Drink 1** and reads everything else live: balance, the exact card
  (`allocRowKey`, else `batchId`), Put Back, recent activity.
- **Share is a plain link the person taps.** `Share to WhatsApp` is an
  `<a target="_blank" rel="noopener noreferrer">` to `wa.me` built before the
  tap; the click handler only records that it was tapped. A preview and Copy
  message are the fallback. Team balances load in the background (5s timeout)
  and the caption says whether they are included.
- **Put Back is unchanged on the server** and bound to the exact cup:
  `undoDrink(opId)` refuses any other cup. It covers the latest cup, on its
  card, through the end of its Jakarta day, and survives a reload via
  `/api/me.undoOffer`. A successful Put Back (or `ALREADY_UNDONE`) flips the
  receipt, clears the offer and returns the cup to its card in one update.
  Undo errors are receipt-scoped (`undoError`), never the shell's `error`.
- **Unconfirmed is not "not counted".** A Drink that gets no answer while online
  says "Couldn't confirm your cup" and asks `/api/me`, whose `undoOffer` then
  guards the next tap. Drink and Undo never take a client timeout (aborting
  could orphan a commit); reads do (history 8s, balances 5s).
- **Honest figures only.** `insights/recent.ts` counts unreversed CONSUME rows
  per Jakarta day. The week, "N cups today" and the 14-day pace are shown only
  when the history page provably covers their window; unknown is left out,
  never drawn as zeros. `SafeSection` drops a failing extra without taking
  down Home, the sheet or the update prompt.
- **Motion is decoration.** Base styles are the final frame; every animation
  sits inside `prefers-reduced-motion: no-preference` with `fill-mode: both`,
  and the whole success cup ends inside `--dur-celebrate` (900ms). All
  durations are tokens in `tokens.css`.

## Contract

| Event | Store | Sheet | Card |
|---|---|---|---|
| Drink succeeds | `receipt{status:'counted'}`, `undo`, `revision+1` | Opens, focuses **Drink 1** | Put Back at top-right |
| Put Back succeeds / `ALREADY_UNDONE` | `receipt.status='putBack'`, `undo=null`, card `+1` | "Cup put back", Share hidden | Button gone, focus to card title |
| `NOT_LATEST_CONSUME` / `UNDO_WINDOW_EXPIRED` | Offer cleared, `undoError` set, `/api/me` | Alert in sheet | Reason beside the card |
| Undo unanswered | Offer kept, `undoError` set, `/api/me` | "Check your balance" | Same |
| Done / Escape / backdrop | `receipt=null` | Closes, focus returns | Offer stays |
| Reload | Offer from `/api/me.undoOffer` | Not reopened | Put Back restored |

## Test matrix

- Unit: `web/tests/state/{coffee,history}.test.ts`,
  `web/tests/shell/{DrinkSummarySheet,DrinkFab,App}.test.tsx`,
  `web/tests/components/{Sheet,PaceCard,RecentBars}.test.tsx`,
  `web/tests/insights/recent.test.ts`, `web/tests/sharing/*.test.ts`,
  `web/tests/MyCoffee.test.tsx`, `web/tests/onboarding/tour.test.ts`.
- Styles: `web/tests/styles/{motion,contrast,scrolling,stacking}.test.ts`.
- End to end: `web/e2e/drink-sheet.spec.ts` (E1 blank tab … E13 pace), plus
  `shell.spec.ts` and `login-home.spec.ts`, on mobile-safari, mobile-chrome,
  narrow 320px and landscape.
- Device checklist (unverified in CI): whether a home-screen iOS app hands the
  `wa.me` tab on to the WhatsApp app on iOS 15.4, 16 and 17.
