/**
 * Guess which pending member a newly signed-in Google account belongs to.
 *
 * This is a **convenience, never an authority**. The prediction pre-selects a
 * name on the claim screen so the common case is one tap; the person still
 * confirms, and an admin can override afterwards. Nothing binds without a
 * deliberate action, because a wrong automatic bind would hand one person's
 * balance to another.
 *
 * Matching is deliberately conservative: it compares the Google display name
 * and the local part of the address against pending display names, and returns
 * a candidate only when one is clearly ahead of the rest.
 */

export interface Candidate {
  memberId: string
  displayName: string
}

export interface Prediction {
  /** Best candidate, or undefined when nothing is clearly ahead. */
  memberId?: string
  /** 0–1. Exposed so the UI can phrase a weak guess more tentatively. */
  confidence: number
}

/** Lowercase, strip punctuation and digits, collapse whitespace. */
export function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Tokens of a signing-in identity: display name plus the address local part. */
export function identityTokens(displayName: string | undefined, email: string): string[] {
  const local = email.split('@')[0] ?? ''
  const fromLocal = normalizeName(local.replace(/[._-]+/g, ' '))
  const fromName = normalizeName(displayName ?? '')
  // Three characters minimum. Two-letter fragments are noise — they turn up in
  // hashes and initials and would score a full exact match against everyone.
  return [...new Set(`${fromName} ${fromLocal}`.split(' ').filter((t) => t.length >= MIN_TOKEN))]
}

/**
 * Score one candidate against the identity tokens.
 *
 * An exact token match is strong evidence ("Andri" vs "Andri"). A prefix match
 * is weaker but real ("Andri" vs "andrianto"). Nothing else counts — fuzzy
 * edit-distance matching produced confident nonsense on short Indonesian first
 * names, which is exactly the population here.
 */
export function scoreCandidate(tokens: string[], displayName: string): number {
  const candidateTokens = normalizeName(displayName)
    .split(' ')
    .filter((t) => t.length >= MIN_TOKEN)
  if (candidateTokens.length === 0 || tokens.length === 0) return 0

  let best = 0
  for (const c of candidateTokens) {
    for (const t of tokens) {
      if (c === t) best = Math.max(best, 1)
      else if (c.length >= 4 && t.length >= 4 && (c.startsWith(t) || t.startsWith(c))) {
        best = Math.max(best, 0.6)
      }
    }
  }
  return best
}

/** Shortest token worth comparing. "Roy" survives; "Bo" would not. */
const MIN_TOKEN = 3

/** Minimum score to offer a prediction at all. */
const FLOOR = 0.6
/** How far ahead the leader must be before we pre-select it. */
const MARGIN = 0.2

export function predictMember(
  candidates: Candidate[],
  displayName: string | undefined,
  email: string,
): Prediction {
  const tokens = identityTokens(displayName, email)
  const scored = candidates
    .map((c) => ({ ...c, score: scoreCandidate(tokens, c.displayName) }))
    .sort((a, b) => b.score - a.score)

  const leader = scored[0]
  if (!leader || leader.score < FLOOR) return { confidence: 0 }

  const runnerUp = scored[1]
  // Two people called "Andri" must not resolve to a coin flip.
  if (runnerUp && leader.score - runnerUp.score < MARGIN) return { confidence: 0 }

  return { memberId: leader.memberId, confidence: leader.score }
}
