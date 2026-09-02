/**
 * The exact character set Azure Table Storage rejects in PartitionKey and
 * RowKey: four punctuation characters, plus the control ranges
 * U+0000-U+001F and U+007F-U+009F.
 *
 * The control characters are *computed* rather than written as literals, so
 * no raw control byte ever appears in the repository source, and so the suite
 * covers the whole forbidden range instead of a hand-picked sample.
 *
 * Space is deliberately NOT in this list - it is legal in Table keys.
 */
const range = (lo: number, hi: number): string[] =>
  Array.from({ length: hi - lo + 1 }, (_, i) => String.fromCharCode(lo + i))

export const FORBIDDEN_PUNCTUATION: readonly string[] = ['/', '\\', '#', '?']

export const FORBIDDEN_CONTROL_CHARS: readonly string[] = [
  ...range(0x00, 0x1f),
  ...range(0x7f, 0x9f),
]

export const FORBIDDEN_KEY_CHARS: readonly string[] = [
  ...FORBIDDEN_PUNCTUATION,
  ...FORBIDDEN_CONTROL_CHARS,
]

/** An opId carrying a control character - the attacker-controlled header case. */
export const OP_ID_WITH_CONTROL_CHAR = `op${String.fromCharCode(0x01)}x`

/** Characters that look risky but are legal, so the validator must accept them. */
export const LEGAL_SAMPLES: readonly string[] = [
  'plain',
  'with space',
  'colon:sep',
  'dot.v1',
  'dash-and_underscore',
  'pipe|sep',
  'tilde~',
  'at@sign',
  'percent%20',
]
