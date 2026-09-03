# Drink Refresh and WhatsApp Handoff Design

## Problem

The floating Drink action can remain disabled after an administrator grants a new coffee batch because the client only loads `/api/me` on authentication changes. The open PWA can therefore keep a stale zero balance indefinitely.

After a successful Drink, the user also wants to publish a current recap headed **Cart Coffee**.

The first implementation performed the wa.me navigation in the app's own browsing context. That "safe" same-context jump is exactly what a real mobile browser punishes: the PWA document is replaced, so the 10-second Put it back offer, the route and the shell are destroyed under the user — mobile Chromium simply lost the app, and WebKit was one policy away from doing the same.

## Approved behavior

1. While authenticated, refresh `/api/me` whenever the document becomes visible again or the browser reconnects. Deduplicate overlapping refreshes.
2. Keep mutations network-only and idempotent. Never consume while offline, loading, busy, or truly empty according to the latest refresh.
3. A direct user click on Drink synchronously reserves one inert, named secondary browsing context (`coffee-sub-wa-handoff`), with its opener severed, so the later automatic jump cannot be popup-blocked. Nothing navigates anywhere — not even the reserved context — until the mutation succeeds.
4. If Drink fails, close the reserved context and show the existing in-app error. Do not open WhatsApp.
5. If Drink succeeds, fetch `/api/balances`, format a concise recap with the drinking member, one consumed cup, the batch label, all current balances, and their total, then navigate the reserved context to `https://wa.me/?text=<encoded recap>`. The PWA keeps its document, route and undo offer in the original window.
6. If team-balance refresh fails after consumption succeeds, still jump with a truthful self-only recap using the Drink response and current member name. Do not misreport the successful consumption as failed.
7. If the user puts the cup back before the recap is ready, close the reserved context instead of jumping.
8. If the reservation itself is blocked, degrade in order: same-context wa.me jump, then a visible Open WhatsApp link. Only navigation degrades — the cup was already consumed exactly once, so no fallback ever re-mutates.
9. Display Put it back for at most 10 seconds. WhatsApp cannot select a private group by display name or press Send; the user chooses the group and confirms sending.

## Boundaries

- `state/coffee.ts` owns refresh deduplication and returns a successful Drink result to the initiating UI.
- `sharing/whatsapp.ts` owns recap formatting, URL generation, reservation of the named handoff context (opener severed), navigation/close of that reservation, and the same-context fallback.
- `DrinkFab.tsx` owns reserving the handoff synchronously from the trusted click and orchestrating success, failure and undo-before-recap closure.
- `App.tsx` owns authenticated resume/reconnect listeners.

## Verification

- Unit tests reproduce stale-zero-on-resume and prove it refreshes.
- Component tests prove one Drink request, a synchronous named reservation inside the click with the opener severed, no jump before success, the correct encoded recap through the reserved context, a truthful self-only recap if balances fail, closure of the reserved context on mutation failure and on undo-before-recap, and both blocked-reservation fallbacks.
- Browser tests intercept `wa.me` at the browser-context level, because the jump happens in the reserved popup; the PWA window keeps its document, snackbar and route, which is asserted after the handoff.
- Existing mutation guard, shell, PWA lifecycle, accessibility, typecheck, lint, build, and browser tests remain green.
