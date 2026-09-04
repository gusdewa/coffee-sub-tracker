import { createHash } from 'node:crypto'

/**
 * Single source of truth for every Azure Table PartitionKey / RowKey format.
 *
 * Azure Table Storage rejects `/`, `\`, `#`, `?` and the control ranges
 * U+0000-U+001F and U+007F-U+009F in key fields. An earlier design used `#`
 * as the family separator, which would have failed on the first write; the
 * separator is `|`, and prefix ranges are bounded by its successor `}`.
 *
 * Ordering is load-bearing, not cosmetic:
 *   - allocations sort oldest-first, so FIFO selection is "take the first row"
 *   - transactions sort newest-first, so history needs no reversal
 * Both rely on fixed-width encodings, because lexicographic comparison only
 * matches numeric comparison when every value has the same width.
 */

export const SEP = '|' as const

/** Successor of SEP (0x7C -> 0x7D), the exclusive upper bound for prefix scans. */
const SEP_SUCCESSOR = '}' as const

export const ILLEGAL_KEY_CHARS: readonly string[] = ['/', '\\', '#', '?']


export class IllegalKeyError extends Error {
  /** Maps to HTTP 422 — this is malformed client input, never a server fault. */
  readonly code = 'VALIDATION_FAILED'

  constructor(field: string, detail: string) {
    // The offending value is deliberately never interpolated: it is
    // attacker-supplied and would otherwise land verbatim in logs and in the
    // response body.
    super(`Invalid ${field}: ${detail}`)
    this.name = 'IllegalKeyError'
  }
}

export function isLegalKey(value: string): boolean {
  // Checked by codepoint rather than by regex so that no literal control
  // character ever appears in this source file.
  for (const ch of value) {
    if (ILLEGAL_KEY_CHARS.includes(ch)) return false
    const c = ch.codePointAt(0) as number
    if (c <= 0x1f) return false
    if (c >= 0x7f && c <= 0x9f) return false
  }
  return true
}

export function assertLegalKey(value: string, field = 'key'): void {
  if (!isLegalKey(value)) {
    throw new IllegalKeyError(field, 'contains a character Azure Table Storage forbids in a key')
  }
}

/**
 * Operation ids reach us through the client's `Idempotency-Key` header, so
 * they are attacker-controlled and become part of a RowKey. Constrain them to
 * a conservative charset rather than merely checking Azure's forbidden list:
 * UUIDs, ULIDs and our own `batch:<id>:<id>` form all fit.
 */
const OP_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/

export function assertValidOpId(opId: string): void {
  if (!OP_ID_PATTERN.test(opId)) {
    throw new IllegalKeyError('operation id', 'must be 1-64 characters of A-Z a-z 0-9 _ . : -')
  }
}

// ---------------------------------------------------------------------------
// Time encodings
// ---------------------------------------------------------------------------

/** Highest millisecond value encodable in 13 digits (year ~2286). */
const MAX_ENCODABLE_MS = 9_999_999_999_999

/** `yyyyMMddTHHmmssZ` — fixed width 16, so string order equals time order. */
export function formatEffectiveAt(date: Date): string {
  const iso = date.toISOString() // 2026-09-02T13:45:00.000Z
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`
}

/**
 * Inverted millisecond clock, zero-padded to 13 characters, so that a *later*
 * instant yields a *smaller* string and ascending RowKey order is newest-first.
 */
export function invTicks(date: Date): string {
  const ms = date.getTime()
  if (!Number.isFinite(ms) || ms < 0 || ms > MAX_ENCODABLE_MS) {
    throw new RangeError('timestamp is outside the encodable range for invTicks')
  }
  return String(MAX_ENCODABLE_MS - ms).padStart(13, '0')
}

// ---------------------------------------------------------------------------
// Prefix ranges
// ---------------------------------------------------------------------------

export interface KeyRange {
  readonly from: string
  readonly to: string
}

/**
 * Half-open range `[prefix|, prefix})` covering every row in one family.
 * Any suffix compares below the bound because `|` < `}` decides at the
 * separator position.
 */
export function prefixRange(familyLetter: string): KeyRange {
  return { from: `${familyLetter}${SEP}`, to: `${familyLetter}${SEP_SUCCESSOR}` }
}

const FAMILY = {
  allocation: 'A',
  idempotency: 'I',
  reversal: 'R',
  transaction: 'T',
  member: 'M',
  emailIndex: 'E',
  linkAudit: 'L',
} as const

export const ALLOC_RANGE: KeyRange = prefixRange(FAMILY.allocation)
export const TXN_RANGE: KeyRange = prefixRange(FAMILY.transaction)
export const MEMBER_RANGE: KeyRange = prefixRange(FAMILY.member)
export const LINK_AUDIT_RANGE: KeyRange = prefixRange(FAMILY.linkAudit)

/**
 * One fixed row per ledger partition serializes Drink and Put Back. Keeping the
 * row in the member partition lets both operations include it in their Azure
 * Table entity-group transaction.
 */
export const LATEST_CONSUME_MARKER_ROW_KEY = 'U|LATEST_CONSUME' as const

// ---------------------------------------------------------------------------
// CoffeeLedger — partition per member
// ---------------------------------------------------------------------------

/** `M|<memberId>` — an opaque ULID, never an email, so no PII enters a key. */
export function ledgerPartitionKey(memberId: string): string {
  assertLegalKey(memberId, 'memberId')
  return `${FAMILY.member}${SEP}${memberId}`
}

/** `A|<effectiveAt>|<batchId>` — ascending order is FIFO order. */
export function allocationRowKey(effectiveAt: Date, batchId: string): string {
  assertLegalKey(batchId, 'batchId')
  return `${FAMILY.allocation}${SEP}${formatEffectiveAt(effectiveAt)}${SEP}${batchId}`
}

/** `T|<invTicks>|<opId>` — ascending order is newest-first. */
export function transactionRowKey(createdAt: Date, opId: string): string {
  assertValidOpId(opId)
  return `${FAMILY.transaction}${SEP}${invTicks(createdAt)}${SEP}${opId}`
}

/**
 * `R|<originalOpId>` — the double-undo sentinel. Inserting it is what makes a
 * second Undo impossible; the conflict is the check, so no query is needed.
 */
export function reversalSentinelRowKey(originalOpId: string): string {
  assertValidOpId(originalOpId)
  return `${FAMILY.reversal}${SEP}${originalOpId}`
}

/** `I|<opId>` — inserting this row *is* the idempotency guarantee. */
export function idempotencyRowKey(opId: string): string {
  assertValidOpId(opId)
  return `${FAMILY.idempotency}${SEP}${opId}`
}

/** Deterministic opId so re-running batch provisioning is a no-op, not a double grant. */
export function batchProvisionOpId(batchId: string, memberId: string): string {
  assertLegalKey(batchId, 'batchId')
  assertLegalKey(memberId, 'memberId')
  const opId = `batch:${batchId}:${memberId}`
  assertValidOpId(opId)
  return opId
}

// ---------------------------------------------------------------------------
// CoffeeMembers — one partition holds the roster and its email index, so
// creating a member writes both rows in a single entity-group transaction.
// ---------------------------------------------------------------------------

export const ROSTER_PARTITION = 'ROSTER' as const

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function emailHash(email: string): string {
  return createHash('sha256').update(normalizeEmail(email), 'utf8').digest('hex')
}

/** `M|<memberId>` within the ROSTER partition. */
export function memberRowKey(memberId: string): string {
  assertLegalKey(memberId, 'memberId')
  return `${FAMILY.member}${SEP}${memberId}`
}

/**
 * `L|<invTicks>|<opId>` in the ROSTER partition — an append-only record of an
 * admin linking an address to a member. It shares the partition with the member
 * row and the email index, so the link, its uniqueness claim and its audit
 * entry all commit together or not at all.
 */
export function linkAuditRowKey(at: Date, opId: string): string {
  assertValidOpId(opId)
  return `${FAMILY.linkAudit}${SEP}${invTicks(at)}${SEP}${opId}`
}

/** `E|<sha256(email)>` — hashed so the index key carries no address. */
export function emailIndexRowKey(email: string): string {
  return `${FAMILY.emailIndex}${SEP}${emailHash(email)}`
}

// ---------------------------------------------------------------------------
// CoffeeBatches / CoffeeQaSessions
// ---------------------------------------------------------------------------

export const BATCH_PARTITION = 'BATCH' as const

export function batchRowKey(effectiveAt: Date, batchId: string): string {
  assertLegalKey(batchId, 'batchId')
  return `${formatEffectiveAt(effectiveAt)}${SEP}${batchId}`
}

export const QA_PARTITION = 'QA' as const

const sha256Hex = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex')

/**
 * `L|<sha256(code)>` — a QA link. The plaintext code is never stored; the hash
 * IS the key, so a lookup is a point read and a stolen table dump yields
 * nothing usable.
 */
export function qaLinkRowKey(code: string): string {
  return `L${SEP}${sha256Hex(code)}`
}

/**
 * `S|<sha256(token)>` — a redeemed QA session.
 *
 * Sessions are opaque server-issued tokens rather than Firebase custom tokens,
 * so the QA path has no dependency on Identity Platform being initialised, and
 * the system needs no signing key at all. Revocation is immediate because every
 * request resolves the session against storage rather than trusting a signature.
 */
export function qaSessionRowKey(token: string): string {
  return `S${SEP}${sha256Hex(token)}`
}

export const QA_LINK_RANGE: KeyRange = prefixRange('L')
export const QA_SESSION_RANGE: KeyRange = prefixRange('S')
