import '@testing-library/jest-dom/vitest'

/*
 * jsdom implements localStorage, but Vitest's jsdom environment copies window
 * properties onto globalThis by own-enumerable key and `localStorage` is a
 * prototype getter, so it does not survive the hop. Without this, storage-backed
 * code cannot be tested at all here — it would silently take its "storage is
 * unavailable" branch and every assertion about remembering something would pass
 * for the wrong reason.
 *
 * Backed by a real Map and exposed as `Storage` so a suite can still spy on the
 * prototype to simulate a browser that refuses to store anything.
 */
if (typeof globalThis.localStorage === 'undefined') {
  class MemoryStorage implements Storage {
    #entries = new Map<string, string>()

    get length(): number {
      return this.#entries.size
    }
    clear(): void {
      this.#entries.clear()
    }
    getItem(key: string): string | null {
      return this.#entries.get(key) ?? null
    }
    key(index: number): string | null {
      return [...this.#entries.keys()][index] ?? null
    }
    removeItem(key: string): void {
      this.#entries.delete(key)
    }
    setItem(key: string, value: string): void {
      this.#entries.set(key, String(value))
    }
    [name: string]: unknown
  }

  const storage = new MemoryStorage()
  Object.defineProperty(globalThis, 'Storage', { value: MemoryStorage, writable: true })
  Object.defineProperty(globalThis, 'localStorage', { value: storage, writable: true })
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: new MemoryStorage(),
    writable: true,
  })
}

/*
 * jsdom 25 ships HTMLDialogElement as an empty shell: `open` reflects the
 * attribute, but there is no showModal(), show() or close(), and Escape does
 * nothing. The app's sheets are native modal dialogs, so without this every
 * suite that opens one would throw — or, worse, pass by falling back to the
 * non-modal path it exists to avoid.
 *
 * Only the parts the app leans on, shaped like browsers where it matters:
 * - showModal() throws InvalidStateError when the dialog is already open or
 *   detached. (The current spec lets an already-modal dialog return silently;
 *   older Safari throws. Stricter here, so a double open fails a test.)
 * - close() fires `close` asynchronously and only if the dialog was open, so a
 *   StrictMode close-then-reopen leaves a stale `close` behind exactly as a
 *   browser would. Browsers queue a task; this queues a microtask, because
 *   Vitest's fake timers freeze setTimeout but not queueMicrotask, and a suite
 *   on fake time must still see the event.
 * - Escape on an open *modal* dialog fires a cancelable `cancel`, and closes it
 *   unless that is prevented. Registered on the document so a component's own
 *   keydown handler runs first, as the browser's default action would.
 * No top layer, no inertness, no focus restoration: components that need
 * those must do the work themselves, which is what the tests should see.
 */
if (typeof HTMLDialogElement !== 'undefined' && !('showModal' in HTMLDialogElement.prototype)) {
  const invalidState = (message: string) => new DOMException(message, 'InvalidStateError')

  Object.assign(HTMLDialogElement.prototype, {
    showModal(this: HTMLDialogElement) {
      if (this.open) throw invalidState('The dialog is already open.')
      if (!this.isConnected) throw invalidState('The dialog is not connected.')
      this.setAttribute('data-modal', '')
      this.setAttribute('open', '')
    },
    show(this: HTMLDialogElement) {
      if (!this.open) this.setAttribute('open', '')
    },
    close(this: HTMLDialogElement, returnValue?: string) {
      if (!this.open) return
      if (returnValue !== undefined) this.returnValue = returnValue
      this.removeAttribute('open')
      this.removeAttribute('data-modal')
      queueMicrotask(() => this.dispatchEvent(new Event('close')))
    },
  })

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    // The most recently opened modal is on top; document order is close enough.
    const modals = document.querySelectorAll<HTMLDialogElement>('dialog[open][data-modal]')
    const top = modals[modals.length - 1]
    if (!top) return
    const cancel = new Event('cancel', { cancelable: true })
    if (top.dispatchEvent(cancel)) top.close()
  })
}
