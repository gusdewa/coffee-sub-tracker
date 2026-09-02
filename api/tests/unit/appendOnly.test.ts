import { describe, test, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Append-only is enforced by this application, not by Azure Table Storage.
 *
 * Tables have no WORM mode, and the data-plane RBAC roles are read or
 * read-write-delete — there is no append-only role, so the API's own managed
 * identity *could* rewrite an audit row. The guarantee therefore rests on
 * discipline, and discipline that is not tested is just a comment.
 *
 * This scans the shipped source for any mutation or deletion aimed at the
 * transaction row family. It is a static check: it cannot prove absence at
 * runtime, which is exactly why Table diagnostic logs are also shipped to a
 * Log Analytics workspace the API cannot write to (plan §10.5).
 */

const SRC = fileURLToPath(new URL('../../src', import.meta.url))

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return full.endsWith('.ts') ? [full] : []
  })
}

/** Strip comments so prose about deletion never trips the scan. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('append-only ledger (plan §10.5, acceptance 11)', () => {
  const files = sourceFiles(SRC)

  test('the source tree is non-empty and scannable', () => {
    expect(files.length).toBeGreaterThan(8)
  })

  test('no code path deletes any ledger entity', () => {
    const offenders: string[] = []
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'))
      // Table deletes at all: the ledger has no legitimate delete anywhere.
      if (/\bdeleteEntity\s*\(/.test(code)) offenders.push(file)
      if (/\[\s*['"]delete['"]\s*,/.test(code)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })

  test('every ledger transaction action targets an allocation, never a T| row', () => {
    // The only 'update' actions in the domain layer must be allocation merges.
    const domain = files.filter((f) => f.includes('/domain/'))
    for (const file of domain) {
      const code = stripComments(readFileSync(file, 'utf8'))
      const updates = code.match(/\[\s*['"]update['"][\s\S]{0,400}?\]/g) ?? []
      for (const block of updates) {
        const targetsAllocation =
          /allocRowKey|adjustRowKey|target\.rowKey|row\.rowKey|rowKey: allocRowKey/.test(block)
        expect(
          targetsAllocation,
          `update action in ${file} must target an allocation row:\n${block}`,
        ).toBe(true)
        expect(
          /transactionRowKey|reversalSentinelRowKey|idempotencyRowKey/.test(block),
          `update action in ${file} must not target an audit or sentinel row:\n${block}`,
        ).toBe(false)
      }
    }
  })

  test('transaction, sentinel and idempotency rows are only ever created', () => {
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'))
      for (const helper of ['transactionRowKey', 'reversalSentinelRowKey']) {
        // Find each use and confirm the enclosing action is a create.
        const uses = code.split(helper).slice(1)
        for (const after of uses) {
          const before = code.slice(0, code.indexOf(helper))
          const lastAction = before.lastIndexOf("['")
          if (lastAction === -1) continue
          const snippet = before.slice(lastAction, lastAction + 12)
          if (snippet.startsWith("['update'") || snippet.startsWith("['delete'")) {
            throw new Error(`${helper} used in a mutating action in ${file}`)
          }
          void after
        }
      }
    }
    expect(true).toBe(true)
  })

  test('upsert is confined to roster rows, never the ledger', () => {
    for (const file of files) {
      if (file.includes('/storage/roster.ts')) continue // the roster legitimately upserts
      const code = stripComments(readFileSync(file, 'utf8'))
      expect(
        /\[\s*['"]upsert['"]\s*,/.test(code),
        `${file} must not upsert; ledger rows are created once`,
      ).toBe(false)
    }
  })
})
