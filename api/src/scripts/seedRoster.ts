/**
 * Seed or update the member roster.
 *
 * The roster is the authorization boundary — a verified Google identity grants
 * nothing until it maps to an active row here — so this runs through GitHub
 * Actions with the deployment identity, never from a workstation.
 *
 * Addresses are supplied as a workflow input at dispatch time, so they are
 * entered by an admin in the GitHub UI and never committed to the repository.
 *
 * Idempotent: an address already on the roster keeps its member id, so
 * re-running never orphans a ledger partition.
 */
import { createTableClient } from '../storage/tableClient.js'
import { TABLES } from '../storage/entities.js'
import { upsertMember, findMemberByEmail, listMembers, RosterCache } from '../storage/roster.js'
import { normalizeEmail } from '../storage/keys.js'
import { ulid } from 'ulid'

interface RosterEntry {
  email: string
  displayName: string
  role?: 'member' | 'admin'
  status?: 'active' | 'disabled'
}

function parseRoster(raw: string | undefined): RosterEntry[] {
  if (!raw?.trim()) throw new Error('ROSTER_JSON is empty')
  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed)) throw new Error('ROSTER_JSON must be a JSON array')

  return parsed.map((item, i) => {
    const e = item as Partial<RosterEntry>
    if (!e.email || typeof e.email !== 'string') throw new Error(`entry ${i}: email is required`)
    if (!e.displayName || typeof e.displayName !== 'string') {
      throw new Error(`entry ${i}: displayName is required`)
    }
    if (e.role && e.role !== 'member' && e.role !== 'admin') {
      throw new Error(`entry ${i}: role must be "member" or "admin"`)
    }
    return {
      email: normalizeEmail(e.email),
      displayName: e.displayName.trim(),
      role: e.role ?? 'member',
      status: e.status ?? 'active',
    }
  })
}

async function main(): Promise<void> {
  const domain = (process.env.ALLOWED_EMAIL_DOMAIN ?? 'srx.co.id').toLowerCase()
  const dryRun = process.env.DRY_RUN === 'true'
  const roster = parseRoster(process.env.ROSTER_JSON)

  // Refuse the whole batch rather than seed a partial roster: an address on
  // the wrong domain could never sign in anyway, and a typo should be loud.
  const wrongDomain = roster.filter((r) => !r.email.endsWith(`@${domain}`))
  if (wrongDomain.length > 0) {
    throw new Error(
      `${wrongDomain.length} address(es) are not @${domain}. Nothing was written.`,
    )
  }
  const seen = new Set<string>()
  for (const r of roster) {
    if (seen.has(r.email)) throw new Error(`duplicate address in input: ${r.email}`)
    seen.add(r.email)
  }
  if (!roster.some((r) => r.role === 'admin')) {
    throw new Error('At least one member must be an admin, or nobody can manage subscriptions.')
  }

  const members = createTableClient(TABLES.members)
  const deps = { members, cache: new RosterCache(0) }

  console.log(`Seeding ${roster.length} member(s) against @${domain}${dryRun ? ' (dry run)' : ''}`)

  for (const entry of roster) {
    const existing = await findMemberByEmail(deps, entry.email)
    const memberId = existing?.memberId ?? ulid()
    const action = existing ? 'update' : 'create'

    // Log the local part only; the full address is not written to CI logs.
    const label = `${entry.email.split('@')[0]}@…`

    if (dryRun) {
      console.log(`  would ${action}: ${label} (${entry.role}, ${entry.status})`)
      continue
    }

    await upsertMember(deps, {
      memberId,
      email: entry.email,
      displayName: entry.displayName,
      role: entry.role ?? 'member',
      status: entry.status ?? 'active',
      ...(existing?.firebaseUid ? { firebaseUid: existing.firebaseUid } : {}),
    })
    console.log(`  ${action}d: ${label} (${entry.role}, ${entry.status})`)
  }

  if (!dryRun) {
    const all = await listMembers(deps)
    const real = all.filter((m) => !m.isSynthetic)
    console.log(
      `Roster now holds ${real.length} member(s), ` +
        `${real.filter((m) => m.role === 'admin').length} admin(s), ` +
        `${real.filter((m) => m.status === 'active').length} active.`,
    )
  }
}

main().catch((err: unknown) => {
  console.error('Seeding failed:', (err as Error).message)
  process.exit(1)
})
