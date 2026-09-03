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
