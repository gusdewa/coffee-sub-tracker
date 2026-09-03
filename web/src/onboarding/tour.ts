/**
 * A short, skippable walkthrough of the real interface.
 *
 * NN/g's position on mobile onboarding is that most of it should not exist, and
 * that what does exist must be "brief, optional", with "a highly visible Skip".
 * So: five steps over the actual shell, no deck of cards, nothing hidden behind
 * it, and it never runs twice on its own.
 *
 * Driver.js does the spotlight. It is MIT, has zero runtime dependencies, and
 * is loaded only when a tour actually starts — the import is dynamic so neither
 * the JS nor the CSS is on the PWA's critical path.
 *
 * On localStorage: the codebase deliberately stores nothing, and says so in
 * QaRedeem and the API client. Those comments are about *tokens* — a QA bearer
 * must not outlive the tab. Whether someone has seen a walkthrough is not a
 * credential, and the alternative is showing it again on every visit.
 */

import type { Config, Driver } from 'driver.js'

export const DONE_KEY = 'onboarding.coffee-sub.v1'
export const SKIPPED_KEY = 'onboarding.coffee-sub.v1.skipped'

export interface TourStep {
  /** Matches a `data-tour` attribute in the shell. */
  target: string
  title: string
  body: string
}

export const TOUR_STEPS: TourStep[] = [
  {
    target: 'profile',
    title: "You're signed in",
    body: 'Your name, help, and the way out all live behind this button.',
  },
  {
    target: 'balance',
    title: 'Your cups',
    body: 'How many you have left, added up across every card you hold.',
  },
  {
    target: 'drink',
    title: 'Take a cup',
    body: 'One tap, from any screen. It comes off your oldest card first.',
  },
  {
    target: 'nav-cards',
    title: 'Where it comes from',
    body: 'Your cards, oldest first. The "next" marker shows which one is up.',
  },
  {
    target: 'nav-history',
    title: 'Changed your mind?',
    body: 'Every cup is listed here, and you have 10 seconds to put one back.',
  },
]

/** Storage can throw outright in private mode, so every access is guarded. */
function readFlag(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeFlag(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // A tour that cannot be remembered is a small loss; a crash is not.
  }
}

export function hasSeenTour(): boolean {
  return readFlag(DONE_KEY) !== null || readFlag(SKIPPED_KEY) !== null
}

export function markFinished(): void {
  writeFlag(DONE_KEY, 'finished')
}

export function markSkipped(): void {
  // Kept apart from the finish flag: a later version can decide to re-offer a
  // skipped tour without having to guess which of the two happened.
  writeFlag(SKIPPED_KEY, new Date().toISOString())
}

export function shouldAutoStart({
  ready,
  updatePending,
}: {
  /** The balance has loaded, so the shell it points at is actually rendered. */
  ready: boolean
  /** A new build is waiting. That outranks a walkthrough. */
  updatePending: boolean
}): boolean {
  return ready && !updatePending && !hasSeenTour()
}

const selectorFor = (step: TourStep) => `[data-tour="${step.target}"]`

export function buildTourConfig({ reducedMotion }: { reducedMotion: boolean }): Config {
  return {
    showProgress: true,
    progressText: '{{current}} of {{total}}',
    nextBtnText: 'Next',
    prevBtnText: 'Back',
    doneBtnText: 'Finish',
    overlayColor: '#17202a',
    overlayOpacity: 0.55,
    stagePadding: 8,
    stageRadius: 12,
    allowClose: true,
    allowKeyboardControl: true,
    // Step 3 points at Drink. An interactive spotlight there would take a cup.
    disableActiveInteraction: true,
    smoothScroll: true,
    skipMissingElement: true,
    waitForElement: 400,
    // tokens.css zeroes durations under reduced motion but leaves transforms
    // alone, so this has to be switched off at the source.
    animate: !reducedMotion,
    popoverClass: 'coffee-tour',
  }
}

let active: Driver | null = null
let restoreFocusTo: HTMLElement | null = null

export function destroyTour(): void {
  active?.destroy()
  active = null
}

/**
 * Start the walkthrough. Resolves false when there is nothing to point at,
 * rather than opening an empty spotlight over a screen that is not ready.
 */
export async function startTour(): Promise<boolean> {
  if (typeof document === 'undefined') return false

  const present = TOUR_STEPS.filter((step) => document.querySelector(selectorFor(step)))
  if (present.length === 0) return false

  destroyTour()
  restoreFocusTo = document.activeElement as HTMLElement | null

  const reducedMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const { driver } = await import('driver.js')
  await import('driver.js/dist/driver.css')

  const instance = driver({
    ...buildTourConfig({ reducedMotion }),
    steps: present.map((step) => ({
      element: selectorFor(step),
      popover: { title: step.title, description: step.body },
    })),
    onPopoverRender: (popover) => {
      // Driver.js renders a plain div; announce it as what it behaves like, and
      // put focus on the words rather than leaving it on whatever was beneath.
      const wrapper = popover.wrapper
      wrapper.setAttribute('role', 'dialog')
      wrapper.setAttribute('aria-modal', 'true')
      popover.title.id = 'coffee-tour-title'
      wrapper.setAttribute('aria-labelledby', 'coffee-tour-title')
      popover.title.tabIndex = -1
      popover.title.focus()

      // Skip stays visible on every step, not only the first.
      if (!popover.footerButtons.querySelector('.coffee-tour__skip')) {
        const skip = document.createElement('button')
        skip.type = 'button'
        skip.className = 'coffee-tour__skip'
        skip.textContent = 'Skip'
        skip.addEventListener('click', () => {
          markSkipped()
          destroyTour()
        })
        popover.footerButtons.prepend(skip)
      }
    },
    onDestroyed: () => {
      active = null
      restoreFocusTo?.focus?.()
      restoreFocusTo = null
    },
    // Fires on the last step's button, which is the only "finished" signal.
    onDoneClick: () => {
      markFinished()
      destroyTour()
    },
  })

  active = instance
  instance.drive()
  return true
}

/** Test-only: forget both flags. */
export function resetTourMemory(): void {
  try {
    localStorage.removeItem(DONE_KEY)
    localStorage.removeItem(SKIPPED_KEY)
  } catch {
    /* nothing to forget */
  }
}
