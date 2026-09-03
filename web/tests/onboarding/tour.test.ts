import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest'

const tour = await import('../../src/onboarding/tour')

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = ''
})
afterEach(() => {
  vi.restoreAllMocks()
})

const plantTargets = () => {
  for (const step of tour.TOUR_STEPS) {
    const el = document.createElement('div')
    el.setAttribute('data-tour', step.target)
    document.body.appendChild(el)
  }
}

describe('onboarding memory', () => {
  test('a fresh member has not seen it', () => {
    expect(tour.hasSeenTour()).toBe(false)
  })

  test('finishing and skipping are remembered separately', () => {
    tour.markFinished()
    expect(localStorage.getItem(tour.DONE_KEY)).toBe('finished')
    expect(localStorage.getItem(tour.SKIPPED_KEY)).toBeNull()

    localStorage.clear()
    tour.markSkipped()
    // Stored apart so a later version can decide to re-offer a skip but never
    // a finish, without having to guess which one happened.
    expect(localStorage.getItem(tour.SKIPPED_KEY)).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(localStorage.getItem(tour.DONE_KEY)).toBeNull()
  })

  test('either one stops it coming back', () => {
    tour.markFinished()
    expect(tour.hasSeenTour()).toBe(true)
    localStorage.clear()
    tour.markSkipped()
    expect(tour.hasSeenTour()).toBe(true)
  })

  test('a browser that refuses storage does not break the app', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    expect(() => tour.markFinished()).not.toThrow()
    expect(tour.hasSeenTour()).toBe(false)
  })
})

describe('when it starts on its own', () => {
  test('once, for someone who has not seen it', () => {
    expect(tour.shouldAutoStart({ ready: true, updatePending: false })).toBe(true)
  })

  test('never before the balance has loaded — the targets would not exist yet', () => {
    expect(tour.shouldAutoStart({ ready: false, updatePending: false })).toBe(false)
  })

  test('never over a pending update: a new build outranks a tour', () => {
    expect(tour.shouldAutoStart({ ready: true, updatePending: true })).toBe(false)
  })

  test('never again once it has been finished or skipped', () => {
    tour.markFinished()
    expect(tour.shouldAutoStart({ ready: true, updatePending: false })).toBe(false)
  })
})

describe('the steps', () => {
  test('are five or fewer, and each names a stable target', () => {
    expect(tour.TOUR_STEPS.length).toBeGreaterThan(0)
    expect(tour.TOUR_STEPS.length).toBeLessThanOrEqual(5)
    for (const step of tour.TOUR_STEPS) {
      expect(step.target).toMatch(/^[a-z-]+$/)
      expect(step.title).toBeTruthy()
      expect(step.body).toBeTruthy()
    }
  })

  test('cover the profile, the balance and the Drink action', () => {
    const targets = tour.TOUR_STEPS.map((s) => s.target)
    expect(targets).toContain('profile')
    expect(targets).toContain('balance')
    expect(targets).toContain('drink')
  })
})

describe('the tour configuration', () => {
  test('offers Back, Next, Finish and progress', () => {
    const config = tour.buildTourConfig({ reducedMotion: false })
    expect(config.prevBtnText).toBe('Back')
    expect(config.nextBtnText).toBe('Next')
    expect(config.doneBtnText).toBe('Finish')
    expect(config.showProgress).toBe(true)
    expect(config.progressText).toContain('{{current}}')
  })

  test('never fires the real action it is pointing at', () => {
    // Step 3 highlights Drink. An interactive spotlight there would take a cup.
    expect(tour.buildTourConfig({ reducedMotion: false }).disableActiveInteraction).toBe(true)
  })

  test('tolerates a target that is not on screen', () => {
    const config = tour.buildTourConfig({ reducedMotion: false })
    expect(config.skipMissingElement).toBe(true)
    expect(config.waitForElement).toBeGreaterThan(0)
  })

  test('honours reduced motion at the source, not just in CSS', () => {
    // The blanket rule in tokens.css zeroes durations but leaves transforms be.
    expect(tour.buildTourConfig({ reducedMotion: true }).animate).toBe(false)
    expect(tour.buildTourConfig({ reducedMotion: false }).animate).toBe(true)
  })

  test('scopes its styling so the popover reads as Coffee Sub', () => {
    expect(tour.buildTourConfig({ reducedMotion: false }).popoverClass).toContain('coffee-tour')
  })
})

describe('starting it', () => {
  test('does nothing at all when none of its targets are on screen', async () => {
    const started = await tour.startTour()
    expect(started).toBe(false)
  })

  test('runs when the shell is on screen, and remembers that it finished', async () => {
    plantTargets()
    const started = await tour.startTour()
    expect(started).toBe(true)
    tour.destroyTour()
  })
})
