import { test, describe } from 'vitest'
import assert from 'node:assert/strict'
import {
  FORBIDDEN_KEY_CHARS as FORBIDDEN,
  OP_ID_WITH_CONTROL_CHAR,
  LEGAL_SAMPLES,
} from "./forbidden-chars.js"
import {
  SEP,
  ILLEGAL_KEY_CHARS,
  isLegalKey,
  assertLegalKey,
  ledgerPartitionKey,
  allocationRowKey,
  transactionRowKey,
  reversalSentinelRowKey,
  idempotencyRowKey,
  batchProvisionOpId,
  prefixRange,
  ALLOC_RANGE,
  TXN_RANGE,
  ROSTER_PARTITION,
  memberRowKey,
  emailIndexRowKey,
  normalizeEmail,
  emailHash,
  BATCH_PARTITION,
  batchRowKey,
  QA_PARTITION,
  qaSessionRowKey,
  formatEffectiveAt,
  invTicks,
} from '../../src/storage/keys.js'

const ULID_A = '01JQ0000000000000000000000'
const ULID_B = '01JQ0000000000000000000001'
const OP = '9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f'


function assertKeyIsLegal(key: string, label: string): void {
  for (const ch of FORBIDDEN) {
    assert.ok(!key.includes(ch), `${label} must not contain ${JSON.stringify(ch)}: ${JSON.stringify(key)}`)
  }
  assert.ok(isLegalKey(key), `${label} should pass isLegalKey: ${JSON.stringify(key)}`)
}

describe('key legality (plan r1 — the defect that broke revision 1)', () => {
  test('the separator is legal and is not "#"', () => {
    assert.equal(SEP, '|')
    assert.ok(!ILLEGAL_KEY_CHARS.includes(SEP))
  })

  test('every generated key is free of / \\ # ? and control characters', () => {
    const d = new Date('2026-09-02T13:45:00Z')
    const keys: Array<[string, string]> = [
      ['ledgerPartitionKey', ledgerPartitionKey(ULID_A)],
      ['allocationRowKey', allocationRowKey(d, ULID_B)],
      ['transactionRowKey', transactionRowKey(d, OP)],
      ['reversalSentinelRowKey', reversalSentinelRowKey(OP)],
      ['idempotencyRowKey', idempotencyRowKey(OP)],
      ['memberRowKey', memberRowKey(ULID_A)],
      ['emailIndexRowKey', emailIndexRowKey('Dewa@SRX.co.id')],
      ['batchRowKey', batchRowKey(d, ULID_B)],
      ['qaSessionRowKey', qaSessionRowKey('some-high-entropy-code')],
      ['ROSTER_PARTITION', ROSTER_PARTITION],
      ['BATCH_PARTITION', BATCH_PARTITION],
      ['QA_PARTITION', QA_PARTITION],
      ['batchProvisionOpId', batchProvisionOpId(ULID_B, ULID_A)],
    ]
    for (const [label, key] of keys) assertKeyIsLegal(key, label)
  })

  test('isLegalKey rejects each forbidden character', () => {
    for (const ch of FORBIDDEN) {
      assert.equal(isLegalKey(`ok${ch}bad`), false, `should reject ${JSON.stringify(ch)}`)
    }
    for (const ok of LEGAL_SAMPLES) assert.equal(isLegalKey(ok), true, `should accept ${JSON.stringify(ok)}`)
  })

  test('a client-supplied opId containing an illegal char is rejected, not encoded', () => {
    // The Idempotency-Key header is attacker-controlled; keys.ts is the choke point.
    const bad = ["op#1", "op/1", "op\\\\1", "op?1", OP_ID_WITH_CONTROL_CHAR]
    for (const b of bad) {
      assert.throws(() => idempotencyRowKey(b), /illegal|invalid/i, `should reject ${JSON.stringify(b)}`)
      assert.throws(() => transactionRowKey(new Date(), b), /illegal|invalid/i)
    }
  })

  test('assertLegalKey throws on an illegal key and passes a legal one', () => {
    assert.throws(() => assertLegalKey('a#b'), /illegal|invalid/i)
    assert.doesNotThrow(() => assertLegalKey('a|b'))
  })
})

describe('allocation ordering is FIFO by RowKey alone', () => {
  test('older effectiveAt sorts first', () => {
    const older = allocationRowKey(new Date('2026-01-01T00:00:00Z'), ULID_B)
    const newer = allocationRowKey(new Date('2026-06-01T00:00:00Z'), ULID_A)
    assert.ok(older < newer, `${older} should sort before ${newer}`)
  })

  test('same timestamp falls back to batchId as a deterministic tiebreaker', () => {
    const d = new Date('2026-03-03T03:03:03Z')
    assert.ok(allocationRowKey(d, ULID_A) < allocationRowKey(d, ULID_B))
  })

  test('lexicographic sort equals chronological sort over a shuffled set', () => {
    const dates = [
      '2026-12-31T23:59:59Z', '2025-01-01T00:00:00Z', '2026-02-28T12:00:00Z',
      '2026-03-01T00:00:00Z', '2025-07-04T06:30:00Z',
    ].map((s) => new Date(s))
    const byKey = dates.map((d) => allocationRowKey(d, ULID_A)).sort()
    const byTime = [...dates].sort((a, b) => a.getTime() - b.getTime()).map((d) => allocationRowKey(d, ULID_A))
    assert.deepEqual(byKey, byTime)
  })
})

describe('prefix ranges select exactly one row family', () => {
  test('ALLOC_RANGE contains allocations and excludes every other family', () => {
    const d = new Date('2026-09-02T13:45:00Z')
    const alloc = allocationRowKey(d, ULID_A)
    assert.ok(alloc >= ALLOC_RANGE.from && alloc < ALLOC_RANGE.to, 'allocation must be inside its range')
    for (const other of [transactionRowKey(d, OP), reversalSentinelRowKey(OP), idempotencyRowKey(OP)]) {
      assert.ok(other < ALLOC_RANGE.from || other >= ALLOC_RANGE.to, `${other} must be outside ALLOC_RANGE`)
    }
  })

  test('TXN_RANGE contains transactions and excludes every other family', () => {
    const d = new Date('2026-09-02T13:45:00Z')
    const txn = transactionRowKey(d, OP)
    assert.ok(txn >= TXN_RANGE.from && txn < TXN_RANGE.to)
    for (const other of [allocationRowKey(d, ULID_A), reversalSentinelRowKey(OP), idempotencyRowKey(OP)]) {
      assert.ok(other < TXN_RANGE.from || other >= TXN_RANGE.to, `${other} must be outside TXN_RANGE`)
    }
  })

  test('the upper bound is the separator successor, so any suffix stays inside', () => {
    const r = prefixRange('A')
    assert.equal(r.from, 'A|')
    assert.equal(r.to, 'A}')
    for (const suffix of ['', '0', 'zzzz', '~~~~', '||||', '|']) {
      assert.ok(`A|${suffix}` < r.to, `A|${suffix} must sort below ${r.to}`)
    }
  })
})

describe('transaction ordering is newest-first', () => {
  test('a later timestamp produces a lexicographically smaller RowKey', () => {
    const earlier = transactionRowKey(new Date('2026-01-01T00:00:00Z'), OP)
    const later = transactionRowKey(new Date('2026-06-01T00:00:00Z'), OP)
    assert.ok(later < earlier, 'newer transactions must sort first')
  })

  test('invTicks is fixed-width so lexicographic order matches numeric order', () => {
    const a = invTicks(new Date('2000-01-01T00:00:00Z'))
    const b = invTicks(new Date('2026-01-01T00:00:00Z'))
    assert.equal(a.length, 13)
    assert.equal(b.length, 13)
    assert.ok(b < a)
  })

  test('invTicks refuses a date beyond the encodable range', () => {
    assert.throws(() => invTicks(new Date(10_000_000_000_000)), /range/i)
  })
})

describe('email index carries no PII and normalizes', () => {
  test('hash is lowercase hex of length 64', () => {
    assert.match(emailHash('a@b.co'), /^[0-9a-f]{64}$/)
  })

  test('case and surrounding whitespace do not change identity', () => {
    assert.equal(normalizeEmail('  Dewa@SRX.co.id '), 'dewa@srx.co.id')
    assert.equal(emailHash('  Dewa@SRX.co.id '), emailHash('dewa@srx.co.id'))
    assert.equal(emailIndexRowKey('  Dewa@SRX.co.id '), emailIndexRowKey('dewa@srx.co.id'))
  })

  test('different addresses hash differently', () => {
    assert.notEqual(emailHash('a@srx.co.id'), emailHash('b@srx.co.id'))
  })

  test('the index RowKey never contains the raw address', () => {
    const key = emailIndexRowKey('dewa@srx.co.id')
    assert.ok(!key.includes('dewa'))
    assert.ok(!key.includes('@'))
  })

  test('the ledger partition key never contains an email address', () => {
    assert.ok(!ledgerPartitionKey(ULID_A).includes('@'))
  })
})

describe('effectiveAt encoding', () => {
  test('is fixed-width UTC basic format', () => {
    assert.equal(formatEffectiveAt(new Date('2026-09-02T13:45:00Z')), '20260902T134500Z')
    assert.equal(formatEffectiveAt(new Date('2026-01-05T04:03:02Z')), '20260105T040302Z')
  })

  test('all encodings share one width so comparison is positional', () => {
    const widths = new Set(
      ['1999-12-31T23:59:59Z', '2026-09-02T00:00:00Z', '2200-01-01T12:00:00Z']
        .map((s) => formatEffectiveAt(new Date(s)).length),
    )
    assert.equal(widths.size, 1)
  })
})

describe('batch provisioning idempotency key', () => {
  test('is deterministic per (batch, member) and legal', () => {
    const a = batchProvisionOpId(ULID_B, ULID_A)
    assert.equal(a, batchProvisionOpId(ULID_B, ULID_A))
    assert.notEqual(a, batchProvisionOpId(ULID_B, '01JQ0000000000000000000002'))
    assertKeyIsLegal(idempotencyRowKey(a), 'idempotencyRowKey(batchProvisionOpId)')
  })
})
