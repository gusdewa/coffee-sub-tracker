# Drink Refresh and WhatsApp Handoff Design

## Problem

The floating Drink action can remain disabled after an administrator grants a new coffee batch because the client only loads `/api/me` on authentication changes. The open PWA can therefore keep a stale zero balance indefinitely.

After a successful Drink, the user also wants to publish a current recap to the WhatsApp group named **Cart Coffee (temp)**.

## Approved behavior

1. While authenticated, refresh `/api/me` whenever the document becomes visible again or the browser reconnects. Deduplicate overlapping refreshes.
2. Keep mutations network-only and idempotent. Never consume while offline, loading, busy, or truly empty according to the latest refresh.
3. A direct user click on Drink synchronously opens one inert handoff window, preserving browser popup permission while the network mutation runs.
4. If Drink fails, close the handoff window and show the existing in-app error. Do not open WhatsApp.
5. If Drink succeeds, fetch `/api/balances`, format a concise recap with the drinking member, one consumed cup, the batch label, and all current balances, then navigate the already-open handoff window to `https://wa.me/?text=<encoded recap>`.
6. If team-balance refresh fails after consumption succeeds, still open WhatsApp with a truthful self-only recap using the Drink response and current member name. Do not misreport the successful consumption as failed.
7. Preserve the 90-second Undo flow in the PWA. WhatsApp cannot select a group by display name or press Send; the user chooses **Cart Coffee (temp)** and confirms sending.

## Boundaries

- `state/coffee.ts` owns refresh deduplication and returns a successful Drink result to the initiating UI.
- A focused `sharing/whatsapp.ts` module owns recap formatting, URL generation, and safe handoff-window navigation.
- `DrinkFab.tsx` owns opening the handoff from the trusted click and orchestrating success/failure.
- `App.tsx` owns authenticated resume/reconnect listeners.

## Verification

- Unit tests reproduce stale-zero-on-resume and prove it refreshes.
- Component tests prove one Drink request, a WhatsApp pre-open on the click, correct encoded recap after success, fallback recap if balances fail, and closure on mutation failure.
- Existing mutation guard, shell, PWA lifecycle, accessibility, typecheck, lint, build, and browser tests remain green.
- Deploy through the existing GitHub Actions Pages workflow and verify the deployed build and production URL.
