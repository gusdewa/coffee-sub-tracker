/**
 * Generate the PWA icon set.
 *
 * Written as a script rather than committed binaries alone so the artwork is
 * reproducible and reviewable. No image dependency: a PNG is a handful of
 * chunks around a zlib stream, and this only needs flat shapes.
 *
 * Run: node scripts/generate-icons.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const OUT = new URL('../public/icons/', import.meta.url)

const INK = [23, 32, 42]
const ACTION = [180, 83, 31]
const PAPER = [242, 244, 241]

/**
 * `safeScale` shrinks the artwork for maskable icons. Android may crop to a
 * circle of 80% diameter, so a maskable icon must keep everything meaningful
 * well inside that — the background bleeds to the edge instead.
 */
function drawIcon(size, { maskable = false, rounded = true } = {}) {
  const px = (x, y) => {
    const s = maskable ? 0.62 : 0.78 // artwork extent, fraction of the icon
    const cx = size / 2
    const cy = size / 2
    const half = (size * s) / 2

    // Cup body: a trapezoid-ish block with a rim, centred.
    const bodyTop = cy - half * 0.35
    const bodyBottom = cy + half * 0.72
    const bodyLeft = cx - half * 0.52
    const bodyRight = cx + half * 0.34
    const rimTop = cy - half * 0.58
    const rimBottom = bodyTop

    const inRim = y >= rimTop && y < rimBottom && x >= bodyLeft - half * 0.06 && x <= bodyRight + half * 0.06
    const inBody = y >= bodyTop && y <= bodyBottom && x >= bodyLeft && x <= bodyRight

    // Handle: an arc on the right of the body.
    const hx = bodyRight + half * 0.22
    const hy = cy + half * 0.1
    const dh = Math.hypot(x - hx, y - hy)
    const inHandle = dh <= half * 0.3 && dh >= half * 0.18 && x >= bodyRight - half * 0.02

    if (inRim || inBody || inHandle) return PAPER
    return ACTION
  }

  const bytesPerRow = size * 4 + 1
  const raw = Buffer.alloc(size * bytesPerRow)
  const r = rounded && !maskable ? Math.round(size * 0.22) : 0

  for (let y = 0; y < size; y++) {
    raw[y * bytesPerRow] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      let alpha = 255
      if (r > 0) {
        const cx = Math.min(x, size - 1 - x)
        const cy = Math.min(y, size - 1 - y)
        if (cx < r && cy < r) {
          const dx = r - cx
          const dy = r - cy
          if (dx * dx + dy * dy > r * r) alpha = 0
        }
      }
      const [cr, cg, cb] = px(x, y)
      const o = y * bytesPerRow + 1 + x * 4
      raw[o] = cr
      raw[o + 1] = cg
      raw[o + 2] = cb
      raw[o + 3] = alpha
    }
  }
  return encodePng(size, raw)
}

let crcTable = null
function crc32(buf) {
  if (!crcTable) {
    crcTable = []
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c
    }
  }
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

function encodePng(size, raw) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

mkdirSync(OUT, { recursive: true })
const files = [
  ['icon-192.png', drawIcon(192)],
  ['icon-512.png', drawIcon(512)],
  // Full-bleed background, artwork inside the safe circle.
  ['maskable-512.png', drawIcon(512, { maskable: true })],
  // iOS ignores the manifest icons and squares the corners itself.
  ['apple-touch-icon-180.png', drawIcon(180, { rounded: false })],
]
for (const [name, buf] of files) {
  writeFileSync(new URL(name, OUT), buf)
  console.log(`  ${name} (${buf.length} bytes)`)
}
void INK
