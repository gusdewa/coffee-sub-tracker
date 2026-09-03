# coffee-sub-tracker

Office coffee subscription balances, replacing a WhatsApp thread. Sign in with
Google, see how many cups you have left, tap **Drink**. It comes off your
oldest card first, and the interface offers 10 seconds to put it back.

- **Frontend** — React + TypeScript + Vite, host-neutral: a GitHub Pages
  project site today, buildable for Cloudflare Pages at the root
- **Identity** — Firebase Authentication (Google sign-in only); it supplies
  ID tokens and nothing else
- **Data** — Azure Table Storage, account `smartinnovdigitalassets`
- **API** — a trusted Node service on Azure App Service that verifies Firebase
  tokens and performs every table read and write

No storage key or SAS exists in the browser, in this repository, or in CI.

## How the interesting parts work

**A tap decrements exactly one unit, exactly once.** The oldest allocation with
units left, the audit row, and the idempotency record all live in the member's
own Table partition, and Azure entity-group transactions are atomic within a
partition — so all three commit together or not at all.

Two properties fall out of that structure rather than out of convention:

- **Non-negativity comes from the ETag**, not from the `remaining > 0` check.
  The check picks a candidate; the precondition refuses to commit if anyone
  touched that row in between. Two people cannot both spend the last cup.
- **Idempotency is the insert.** A duplicate `Idempotency-Key` collides on the
  row key and the whole transaction fails, so a retry cannot produce a second
  drink. There is no read-then-check race.

A *simultaneous tap* and a *retried tap* are different events: distinct
operation ids each consume, an identical one consumes once and replays the
original answer.

**Undo never mutates history.** A reversal inserts a new row plus a sentinel
`R|<originalOpId>`; the original CONSUME row is untouched. "Already undone?" is
a point read, and a double undo is refused by the insert conflict itself.

**Append-only is enforced by this application, not by the storage.** Azure
Tables have no WORM mode, and table RBAC offers only read or read-write-delete —
there is no append-only role, so the API's identity could technically delete an
audit row. Two things stand in for that: no code path constructs an update or
delete against a `T|` row (asserted by test), and Table diagnostic logs go to a
Log Analytics workspace the API cannot write to, so any out-of-band mutation is
independently visible.

## Layout

```
api/   trusted service — token verification, all table access
web/   the SPA
```

Key formats live in exactly one file, `api/src/storage/keys.ts`. Azure forbids
`/ \ # ?` and control characters in keys, so the separator is `|` and prefix
scans are bounded by its successor `}`. Member ids are opaque ULIDs — no email
address ever enters a key.

## Running locally

```sh
npm install
npx azurite-table --location ./__azurite__ --silent \
  --tableHost 127.0.0.1 --tablePort 10002 &   # local Table emulator
npm test                                       # api + web
npm run dev -w @coffee-sub/web
```

> **Installing dependencies on the SMART-VIP network.** `registry.npmjs.org` is
> firewall-blocked, and the corporate Nexus mirror is cache-only and missing
> several packages (including `@azure/data-tables`). Install through a complete
> reachable mirror, with an isolated config so Nexus credentials are not sent
> to it:
>
> ```sh
> printf 'registry=https://registry.yarnpkg.com/\n' > /tmp/npmrc
> NPM_CONFIG_USERCONFIG=/tmp/npmrc npm install
> ```

The API needs `AZURE_TABLES_CONNECTION_STRING` only for the emulator. Setting it
while `NODE_ENV=production` makes the process refuse to start, so a deployment
can never silently downgrade to key-based auth.

## Configuration

| Setting | Purpose |
|---|---|
| `FIREBASE_PROJECT_ID` | token issuer/audience — `coffee-sub-tracker-f4551d` |
| `ALLOWED_EMAIL_DOMAIN` | identity domain — `gmail.com` (members sign in with a personal Google account) |
| `STORAGE_ACCOUNT_NAME` | `smartinnovdigitalassets` |
| `ALLOWED_ORIGINS` | `https://gusdewa.github.io,https://coffee-sub.pages.dev` |
| `UNDO_WINDOW_SECONDS` | default 90 |

Storage uses `DefaultAzureCredential` (the App Service managed identity), and
ID-token verification uses Google's public JWKS. QA sessions are opaque tokens
issued and revoked by the API itself. **The system therefore holds no secrets
at all.**

## Known limits

- **Rate limiting is in-process.** Correct for the single B3 instance this runs
  on. Scaling out to more than one instance needs a shared store, or the limits
  become per-instance.
- **Batch provisioning spans partitions and cannot be atomic.** A batch is
  written as `provisioning`, then one transaction per member, then flipped to
  `active`. If it fails partway, some members can drink from it and others
  cannot; `POST /api/admin/batches/{id}/reprovision` converges without
  double-granting.
- **The service worker never caches the API.** An explicit `NetworkOnly` rule
  covers the API origin, asserted against the *built* worker rather than the
  config, because a `urlPattern` closure serialises into the worker as an
  undefined identifier.
- **Offline `Drink` is disabled on purpose.** Idempotency would stop a
  duplicate, but not a tap made against a stale balance that lands minutes
  later. A refusal beats a confidently wrong number. The button and the offline
  banner read the same store, so they cannot disagree — for a while this was
  documented here but never actually implemented, and the tap simply failed
  after the fact.
- **Drinking belongs to the shell, not to a screen.** The action and its
  10-second Put it back offer live in `web/src/state/coffee.ts`, so a cup can be taken from
  any route and navigating away no longer discards a live undo window.
- **The WhatsApp jump never leaves the app's own window.** The Drink click
  reserves a named secondary browsing context (`coffee-sub-wa-handoff`, opener
  severed) while the gesture is still trusted; only after the server confirms
  the cup — and the current balances load — does that context jump to `wa.me`
  with the recap. A failed Drink, or a Put it back before the recap is ready,
  closes the reserved context instead. A blocked reservation falls back to a
  same-context jump, then a visible link, and never consumes a second cup.

## Still outstanding

1. Each member's exact personal Gmail. Only the first admin is known up front;
   the rest are seeded pending and bind on first sign-in.
