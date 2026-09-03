# Drink Refresh and WhatsApp Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the floating Drink action recover from externally changed balances and automatically hand a truthful post-consumption recap to WhatsApp.

**Architecture:** Deduplicate authoritative balance refreshes in the coffee store, trigger them on authenticated resume/reconnect, and return the Drink response to the button. The button pre-opens a window during the trusted click, then a pure WhatsApp helper formats current balances and navigates that window only after success.

**Tech Stack:** React 18, TypeScript, Vitest, Testing Library, Vite PWA, WhatsApp `wa.me` web handoff.

---

### Task 1: Refresh stale balances

**Files:**
- Modify: `web/src/state/coffee.ts`
- Modify: `web/src/App.tsx`
- Test: `web/tests/state/coffee.test.ts`
- Test: `web/tests/shell/App.test.tsx`

- [ ] Add a failing store test proving two simultaneous `loadMe()` calls share one `/api/me` request.
- [ ] Add a failing App test that starts at zero, changes the mocked server to a positive balance, dispatches visible/reconnect state, and expects the Drink button to become enabled.
- [ ] Implement in-flight refresh deduplication in `loadMe()` and authenticated `visibilitychange`/`online` listeners in App.
- [ ] Run targeted tests and confirm they pass.

### Task 2: Define WhatsApp recap behavior

**Files:**
- Create: `web/src/sharing/whatsapp.ts`
- Create: `web/tests/sharing/whatsapp.test.ts`

- [ ] Write failing tests for a recap containing the member name, one consumed cup, batch label, and each returned balance, plus an encoded `https://wa.me/?text=` URL.
- [ ] Implement pure `formatCoffeeRecap` and `whatsAppShareUrl` helpers without group-name targeting claims.
- [ ] Run the helper tests and confirm they pass.

### Task 3: Orchestrate the trusted-click handoff

**Files:**
- Modify: `web/src/state/coffee.ts`
- Modify: `web/src/shell/DrinkFab.tsx`
- Modify: `web/tests/shell/DrinkFab.test.tsx`

- [ ] Write failing component tests proving the click synchronously pre-opens one window, a successful Drink fetches balances and navigates it to the encoded recap, a balance-fetch failure navigates with a truthful self-only fallback, and a Drink failure closes it.
- [ ] Change `drink()` to return its successful `DrinkResponse` or `null` without weakening idempotency, mutation guarding, or existing UI errors.
- [ ] Implement the handoff orchestration in DrinkFab. Use the named target `coffee-whatsapp-share` so repeated actions do not create uncontrolled tabs.
- [ ] Run DrinkFab and coffee-store tests and confirm they pass.

### Task 4: Full verification and deployment

**Files:**
- Modify only if a gate exposes a focused defect.

- [ ] Run all repository test, lint, typecheck, build, security, PWA lifecycle, and browser suites defined by package scripts/workflows.
- [ ] Inspect the diff for secrets, unrelated changes, and API caching regressions.
- [ ] Commit the implementation and push `main`.
- [ ] Verify the GitHub Actions workflow conclusion, Pages HTTP 200, deployed build provenance, and production handoff behavior without actually sending a WhatsApp message.
