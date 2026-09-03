import { describe, test, expect } from 'vitest'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveBasePath } from '../../basePath'

/**
 * Icon and manifest assets.
 *
 * The manifest previously advertised icons that were never generated, so every
 * page load logged a 404 and the app could not be installed — a defect only a
 * rendered page revealed. These tests assert the files exist, are real PNGs of
 * the declared size, and are not accidentally blank.
 */

const ICONS = resolve(__dirname, '../../public/icons')
const DIST = resolve(__dirname, '../../dist')

/**
 * The base this dist/ was actually built with. The same source ships to a
 * GitHub Pages subpath and to the Cloudflare root, so the manifest's URLs are
 * derived rather than asserted as a literal.
 */
const BASE = resolveBasePath(process.env.VITE_BASE_PATH)

interface PngInfo {
  width: number
  height: number
  bitDepth: number
  colorType: number
}

/** Read an IHDR without an image library — a PNG header is fixed-layout. */
function readPng(path: string): PngInfo {
  const buf = readFileSync(path)
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  expect(buf.subarray(0, 8).equals(signature), `${path} is not a PNG`).toBe(true)
  expect(buf.subarray(12, 16).toString()).toBe('IHDR')
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24]!,
    colorType: buf[25]!,
  }
}

const EXPECTED: Array<[string, number]> = [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['maskable-512.png', 512],
  ['apple-touch-icon-180.png', 180],
]

describe('icon assets', () => {
  for (const [name, size] of EXPECTED) {
    test(`${name} exists and is a ${size}px PNG`, () => {
      const path = resolve(ICONS, name)
      expect(existsSync(path), `${name} is missing — the manifest would 404`).toBe(true)
      const info = readPng(path)
      expect(info.width).toBe(size)
      expect(info.height).toBe(size)
      expect(info.colorType).toBe(6) // RGBA
    })

    test(`${name} is not a blank placeholder`, () => {
      // A flat single-colour image compresses to almost nothing. Real artwork
      // does not. This catches a generator that silently produced an empty square.
      const bytes = statSync(resolve(ICONS, name)).size
      expect(bytes).toBeGreaterThan(300)
    })
  }

  test('the maskable icon keeps artwork inside the safe area', () => {
    // Android may crop to a circle of 80% diameter. Our generator draws the
    // maskable variant at a smaller extent, so it must differ from the plain
    // icon of the same size — identical bytes would mean the safe area was
    // never applied.
    const plain = readFileSync(resolve(ICONS, 'icon-512.png'))
    const maskable = readFileSync(resolve(ICONS, 'maskable-512.png'))
    expect(maskable.equals(plain)).toBe(false)
  })
})

describe('built manifest', () => {
  const manifestPath = resolve(DIST, 'manifest.webmanifest')
  const built = existsSync(manifestPath)
  const t = built ? test : test.skip

  t('every icon the manifest advertises actually exists in the build', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      icons: Array<{ src: string }>
      start_url: string
      scope: string
    }
    expect(manifest.icons.length).toBeGreaterThanOrEqual(3)
    for (const icon of manifest.icons) {
      // src is base-absolute, e.g. /coffee-sub-tracker/icons/icon-192.png or
      // /icons/icon-192.png at the root — whichever base this build used.
      const rel = icon.src.replace(BASE, '')
      expect(existsSync(resolve(DIST, rel)), `${icon.src} is advertised but absent`).toBe(true)
    }
  })

  t('start_url and scope stay under the project base', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      start_url: string
      scope: string
    }
    expect(manifest.start_url).toBe(BASE)
    expect(manifest.scope).toBe(BASE)
  })
})
