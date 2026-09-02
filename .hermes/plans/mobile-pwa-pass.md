# coffee-sub-tracker — mobile-first PWA pass

> Status: **in flight.** Workstream A (PWA foundation) is implemented and
> tested; the rest follows the order in §6. This file is the working plan —
> it is not waiting on an approval gate.

## Context

The app is live at `https://gusdewa.github.io/coffee-sub-tracker/` with the API on
Azure App Service. Visual QA against the deployed site (Chrome DevTools MCP, mobile
390×844 and desktop 1440×900) confirmed the core flows render and behave correctly —
punch cards, `Drink 1`, Undo, All Balances, History, zero-balance — with a clean
console and all-200 network.

That same pass also found what only a rendered page reveals: History showed a raw ULID
instead of the batch name, the manifest advertised icons that were never created (404
on every load, so the app could not be installed), and a failed sign-in surfaced only
as an unhandled promise rejection. All three are fixed and deployed.

What remains is that this is a **web page that resembles an app**, not an app. It has
a manifest and icons but no service worker, no install path, no offline shell, no
explicit auth persistence, and no update story. The people using it stand at a coffee
machine holding a cup: the app should open from the home screen, already signed in, and
answer one number instantly.

**Outcome:** an installable, offline-shell PWA that is excellent on iPhone Safari and
Android Chrome, keeps `gusdewa@gmail.com` signed in across restarts, and never caches a
credential or an authenticated response.

---

## 1. Current state (verified, not assumed)

| Area | Finding |
|---|---|
| `web/vite.config.ts` | `base: '/coffee-sub-tracker/'`, React plugin only. **No PWA plugin.** `sourcemap: true` ships a 1.5 MB map publicly. |
| Service worker | **None.** No offline shell, no update UX. |
| `web/public/manifest.webmanifest` | name/short_name/start_url/display/theme present; icons 192+512 now exist. **No maskable icon, no apple-touch-icon.** |
| `web/src/auth/firebase.ts` | Lazy `getAuth(app)`. **No `setPersistence`/`initializeAuth`** — relies on the SDK default. |
| `web/src/api/client.ts` | Sends `Bearer` from `currentIdToken()` (non-forced) or `QA <token>`. **No 401 retry with a force-refreshed token.** QA session is in-memory only — correct, keep. |
| `web/index.html` | `viewport-fit=cover` and dual `theme-color` already present. |
| `web/src/styles/app.css` | Safe-area insets already used on `.nav` and `.app__main`; `prefers-reduced-motion` block exists in `tokens.css`. |
| Routing | `HashRouter` — no `404.html` needed, and the SW `navigateFallback` is therefore trivial. |
| Bundle | ~341 KB raw / 92 KB gzip, dominated by `firebase/auth`. |
| Admin UX | `AdminMembers.tsx` links a pending member's Gmail. **No batch-creation UI** — batches exist only via API/script. |
| Tests | 122 API (vitest + Azurite), 7 web (vitest + RTL). **No Playwright, no Lighthouse.** |

**Design findings from the visual pass** (both real, neither fixed):
- On a 844px-tall phone the `Drink 1` button sits mid-screen with ~40% empty space
  beneath it — the primary action is outside the comfortable thumb arc.
- On desktop the bottom nav spans the full 1440px while content caps at 34rem, so nav
  items splay to the window edges, detached from the column they belong to.

---

## 2. Research — sources and what each one changes here

**vite-plugin-pwa — [generateSW vs injectManifest](https://vite-pwa-org.netlify.app/guide/service-worker-strategies-and-behaviors.html).**
`generateSW` writes the worker for you; `injectManifest` is for "custom runtime
behaviours the generated worker cannot provide". We need precache + navigation
fallback + an explicit never-cache rule for the API — all expressible as config.
→ **Use `generateSW`.** `injectManifest` becomes justified only if we ever add a
background-sync queue, which §3 argues against.

**Chrome installability — [web.dev/articles/install-criteria](https://web.dev/articles/install-criteria).**
Requires HTTPS, `name`/`short_name`, **192 and 512 icons**, `start_url`, `display` in
`standalone|fullscreen|minimal-ui|window-controls-overlay`, and `prefer_related_applications`
absent/false. Notably the article **does not list a service worker as a strict
criterion**, and install is additionally gated on engagement heuristics (a tap plus
~30s). → Our manifest already qualifies; `beforeinstallprompt` gives us a custom
install button, but we must not assume it fires promptly or at all.

**Firebase persistence — [firebase.google.com/docs/auth/web/auth-state-persistence](https://firebase.google.com/docs/auth/web/auth-state-persistence).**
`browserLocalPersistence` survives window close and needs an explicit sign-out; state
lives in localStorage **or IndexedDB**; local persistence synchronises across tabs; and
the docs flag that "if IndexedDB or similar mechanisms are unavailable, fallback
behavior may apply". → Set persistence **explicitly** with an ordered fallback rather
than trusting the default, so a private window or blocked storage degrades to
in-memory instead of throwing at init.

**iOS storage — [webkit.org/blog/14403/updates-to-storage-policy](https://webkit.org/blog/14403/updates-to-storage-policy/).**
Policy scope is "localStorage, Cache API, IndexedDB, Service Worker, and File System".
Eviction happens on quota pressure **or when "the site has not been interacted with by
the user for some time"** — Apple gives no duration. A standalone Home Screen web app
gets the same 60% origin / 80% overall quota as the browser app.
→ **Two hard implications.** (1) "Stays signed in forever" is not promisable on iOS;
auth state can be evicted after inactivity, so a silent sign-out must land the user on
a clean sign-in screen, never a broken one. (2) Cache budget is not the constraint at
our size, but eviction of the SW registration itself is possible — the app must work
when the worker vanishes.

> I checked one widely-repeated claim — a "seven-day cap exempting home-screen apps" —
> against Apple's actual policy page and **it is not there**. Not relying on it.

---

## 2a. Browser and account matrix

Getting this wrong invalidates evidence, so it is stated once, here.

| Surface | Account | Used for |
|---|---|---|
| **Chrome, normal profile** | `gusdewa@gmail.com` | **Authoritative real-SSO validation**: first login and member binding, Dewa admin flows, auth persistence across restart, logout/login, production PWA install/update QA |
| **Chrome, separate/incognito context** | none (synthetic) | QA-link sessions — short-lived, one-time, revocable, non-admin |
| **Chrome DevTools MCP** | none — **its own isolated profile** | Automated synthetic QA only. It is *not* the real profile, so nothing it captures counts as real-SSO evidence |
| **Firefox** | SRX/contact Google account with **Firebase project admin** | Firebase Console clicks *only*, and only when the CLI / Identity Toolkit Admin API cannot enable Google Auth or authorized domains |

**Two rules that follow.** The SRX/contact Gmail is a project-administration
identity and must **never** be seeded as a coffee member. And every screenshot is
labelled with the surface that produced it — synthetic QA evidence is never
presented as real-SSO evidence.

---

## 3. Decisions

**Offline `Drink 1` is disabled, deliberately.** Idempotency keys would prevent a
duplicate charge, but they cannot fix the second problem: offline, the displayed
balance is stale, so the tap is made against a number that may already be wrong, and
the mutation lands minutes later when the person has walked away. For the one number
this app exists to report, a confidently wrong answer is worse than a refusal. The
existing `OfflineBanner` plus a disabled button is the honest behaviour. *Revisit only
if someone actually reports losing drinks to bad wifi.*

**Update strategy: `registerType: 'prompt'`.** A balance app must not swap its bundle
underneath someone mid-tap. Show a "New version — reload" affordance and call
`updateSW()` on their click.

**Never-cache is explicit, not incidental.** Workbox only handles routes you configure,
so omitting the API would already leave it uncached — but a future contributor adding a
broad `runtimeCaching` rule could silently start caching authenticated JSON. An explicit
`NetworkOnly` route for the API origin makes the intent unmissable and testable.

**Nothing auth-related touches the Cache API or the SW.** ID tokens stay in Firebase's
own storage; the QA session stays in a module variable. No token, no `Authorization`
header, and no `/api/*` response is ever written to a cache.

---

## 4. Workstreams

### A. PWA foundation

| Task | Files |
|---|---|
| A1 | Add `vite-plugin-pwa` + `workbox-window` to `web/package.json` (dev + dep respectively) |
| A2 | Configure `VitePWA` in `web/vite.config.ts`: `registerType: 'prompt'`, `strategies: 'generateSW'`, `base`/`scope`/`start_url` all `/coffee-sub-tracker/`, `workbox.navigateFallback: '/coffee-sub-tracker/index.html'`, `globPatterns` for js/css/html/svg/png/woff2, `cleanupOutdatedCaches: true`, and a `runtimeCaching` entry matching the API origin with `handler: 'NetworkOnly'` |
| A3 | Move the manifest from `web/public/manifest.webmanifest` into the plugin's `manifest` option (single source of truth; drop the static file and its `<link>` from `web/index.html`) |
| A4 | Generate icon set into `web/public/icons/`: `icon-192.png`, `icon-512.png`, **`maskable-512.png`** (`purpose: 'maskable'`, art inside the 40% safe circle), `apple-touch-icon-180.png`; add `<link rel="apple-touch-icon">` to `web/index.html` |
| A5 | New `web/src/pwa/useServiceWorker.ts` wrapping `registerSW` from `virtual:pwa-register` — exposes `{ needsRefresh, offlineReady, update() }` |
| A6 | New `web/src/components/UpdateBanner.tsx`, rendered in `App.tsx` beside `OfflineBanner` |
| A7 | Set `build.sourcemap: false` — a 1.5 MB public map is dead weight on a phone |

### B. Install experience

| Task | Files |
|---|---|
| B1 | New `web/src/pwa/useInstallPrompt.ts` — captures `beforeinstallprompt`, exposes `promptInstall()`; must tolerate the event never firing |
| B2 | New `web/src/components/InstallHint.tsx` — Android/Chrome shows a real install button; **iOS Safari shows Share → "Add to Home Screen" guidance instead**, since `beforeinstallprompt` does not exist there. Detect standalone via `matchMedia('(display-mode: standalone)')` **and** `navigator.standalone`, and render nothing when already installed |
| B3 | Dismissal persists in `localStorage` (a convenience, not state) so the hint appears once |

### C. Auth longevity

| Task | Files |
|---|---|
| C1 | `web/src/auth/firebase.ts`: replace `getAuth(app)` with `initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence, inMemoryPersistence] })` — ordered fallback, so blocked storage degrades instead of throwing |
| C2 | `web/src/api/client.ts`: on `401`, retry **once** with `getIdToken(true)`; if it fails again, surface `UNAUTHENTICATED` and route to sign-in |
| C3 | `web/src/api/client.ts`: treat `NOT_ALLOWLISTED` / `MEMBER_DISABLED` as terminal — sign out and show the reason rather than looping |
| C4 | `web/src/App.tsx`: on silent sign-out (evicted storage), land on the clean `SignIn` screen — never a half-rendered shell |

**Unchanged on purpose:** short-lived Firebase ID tokens with SDK refresh; no long-lived
bearer token is ever minted; QA sessions stay opaque, one-time, short-lived, revocable.

### D. Mobile-first UX

| Task | Files |
|---|---|
| D1 | `web/src/styles/app.css` — move the action row to a sticky footer above the nav so `Drink 1` sits in the thumb arc; keep ≥48px targets |
| D2 | `web/src/styles/app.css` — constrain `.nav` inner content to the same `34rem` column as `.screen` (fixes the desktop splay) |
| D3 | `web/src/styles/tokens.css` — fluid type via `clamp()` verified at 320/375/390/430px; ensure zoom to 200% still works (no `user-scalable=no`) |
| D4 | Audit focus-visible rings and AA contrast on `--action`/`--punch` against `--paper` |
| D5 | Transitions limited to `transform`/`opacity`; `prefers-reduced-motion` already handled |

### E. Admin batch UX (currently missing)

| Task | Files |
|---|---|
| E1 | New `web/src/screens/AdminBatches.tsx` — create a batch with label, purchase date, **buyer/payer**, quantity, unit cost, notes, and per-member allocations |
| E2 | `api/src/domain/batches.ts` + `api/src/storage/entities.ts` — extend `BatchEntity` with `buyerMemberId`, `payerMemberId`, `unitCost`, `currency`, `notes`; all optional so existing rows stay valid |
| E3 | `api/src/app.ts` — accept the new fields on `POST /api/admin/batches`; validate that buyer/payer reference real members |
| E4 | Pending members are selectable for allocation (they already can hold a balance) |

### F. Engineering hygiene

| Task | Files |
|---|---|
| F1 | CSP via `<meta http-equiv="Content-Security-Policy">` in `web/index.html` — Pages cannot set headers. Allow `self`, the API origin, and Google identity endpoints; **note `frame-ancestors` is ignored in meta**, so clickjacking protection is not achievable on Pages |
| F2 | Confirm no secret ever enters a `VITE_` var — the Firebase web config is public by design and stays a repo *variable* |
| F3 | Error observability: a small client logger that reports `error.code` + route only — never email, memberId, token, or QA code |

---

## 5. Tests (TDD — write first)

**Unit / integration (vitest, `web/tests/`)**
- `pwa/registration.test.ts` — update-available flow sets `needsRefresh`; `update()` calls the SW updater.
- `pwa/workbox-config.test.ts` — assert the generated `runtimeCaching` contains a `NetworkOnly` rule matching the API origin, and that `globPatterns` include no `/api/` path. **This is the guard that a future contributor cannot silently start caching authenticated JSON.**
- `auth/persistence.test.ts` — `initializeAuth` is called with the ordered persistence array; an IndexedDB failure falls through rather than throwing.
- `api/retry401.test.ts` — a 401 retries exactly once with `getIdToken(true)`; a second 401 does not loop; `MEMBER_DISABLED` does not retry at all.
- `screens/MyCoffee.offline.test.tsx` — offline disables `Drink 1` and no request is issued.
- Extend `api/tests/integration/admin.test.ts` for buyer/payer persistence and validation.

**End-to-end (new `web/e2e/`, Playwright)**
- Projects: **WebKit @ iPhone 13 (390×844)** and **Chromium @ Pixel 7 (412×915)**, plus desktop Chromium 1440×900. Widths 320 / 375 / 390 / 430 asserted for no horizontal scroll.
- Scenarios: install/manifest validity; offline app shell serves while `Drink 1` is disabled; update-available banner appears and reload applies it; **recovery when the SW is unregistered mid-session**; sign-in screen renders after storage is cleared (the iOS eviction case).
- Auth is stubbed at the network boundary; no real Google credentials in CI.

**Budgets**
- Lighthouse CI in `.github/workflows/ci.yml`: PWA installable, Performance ≥ 90 on mobile emulation, Accessibility ≥ 95, and a JS transfer budget ≤ 120 KB gzip (headroom over today's 92 KB).

**Real-device QA** — repeat the DevTools MCP pass at both viewports: screenshots of My Coffee, drink, Undo, zero-balance, All Balances, Subscriptions, History, admin Manage and batch creation; console must be empty; network must show no cached `/api/*`; exercise install, update, offline, reconnect.

---

## 6. Rollout

1. Land behind no flag but in order: **A → C → D → B → E**, each its own PR-sized commit with tests green.
2. Deploy only via Actions (`deploy-web.yml`, `deploy-api.yml`) — unchanged rule.
3. **First SW deploy is the risky one.** `cleanupOutdatedCaches` plus `registerType: 'prompt'` means no client is stranded, but verify on a real device that a hard reload picks up the new worker.
4. **Rollback:** revert the commit and redeploy. Because a bad SW can pin clients to stale assets, keep a `web/public/unregister.html` that unregisters all workers and clears caches — a one-URL escape hatch that needs no store update.
5. Revoke every QA link and disable every synthetic member after QA (already routine here).

---

## 7. Verification gates

| Gate | Evidence required |
|---|---|
| G1 | `npm test` green in both workspaces; Playwright green on WebKit + Chromium |
| G2 | Lighthouse CI meets PWA/Perf/A11y budgets on mobile emulation |
| G3 | DevTools network shows **zero** `/api/*` responses served from a cache, offline and online |
| G4 | Offline: app shell loads, `Drink 1` disabled, banner shown, no queued mutation |
| G5 | Update: banner appears on a new deploy; reload applies it; no stale-asset pinning |
| G6 | Auth: signed in survives a full browser restart; clearing storage lands on a clean sign-in screen |
| G7 | Green Actions runs for web + API, with the Azure deployment log naming the OIDC principal |
| G8 | 0 live QA links, all synthetic members disabled |

---

## 8. Risks and open questions

- **Firebase Auth is still not initialised on `srx-co-id`.** Clicking sign-in returns
  `CONFIGURATION_NOT_FOUND` — proven in-browser. Until Google sign-in is enabled and
  `gusdewa.github.io` is an authorized domain, **C1–C4 cannot be verified end-to-end**
  and admin QA as Dewa is impossible. This gates G6 and workstream E's QA.
- `firebase/auth` dominates the bundle; if the budget in G2 proves tight, the lever is
  lazy-loading the auth module on the sign-in path, not dropping the SW.
- iOS gives no eviction duration, so G6's "survives restart" is verifiable but
  "survives a fortnight idle" is not promisable. The plan handles the failure, rather
  than claiming it cannot happen.
- Pages cannot send real headers, so CSP is best-effort via meta and `frame-ancestors`
  is unavailable.
