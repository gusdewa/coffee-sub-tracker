import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The base path has to be the same for the build and for the tests that read
 * what it built.
 *
 * `dist/` is base-dependent — the manifest's start_url, scope and icon URLs all
 * carry it — and `icons.test.ts` resolves the same variable to decide what
 * those should be. Pages run 33708101869 failed because the Build web step
 * declared VITE_BASE_PATH and the Web tests step did not: the build produced
 * `/coffee-sub-tracker/`, the assertions expected `/`, and the suite failed on
 * a manifest that was entirely correct.
 *
 * The fix is structural rather than a second copy of the value. A variable
 * repeated on two steps is a variable that can drift; declared once on the job,
 * every step inherits it and there is nothing to keep in step by hand.
 */

const WORKFLOWS = resolve(__dirname, '../../../.github/workflows')
const read = (name: string) => readFileSync(resolve(WORKFLOWS, name), 'utf8')

const BUILD_WEB = 'npm run build -w @coffee-sub/web'
const TEST_WEB = 'npm test -w @coffee-sub/web'

interface Job {
  name: string
  body: string
  /** Entries under a job-level `env:` (4-space key, 6-space entries). */
  jobEnv: Record<string, string>
  /** Names declared under a step-level `env:` (8-space key, 10-space entries). */
  stepEnvKeys: string[]
}

/**
 * A deliberately small scanner rather than a YAML dependency: indentation is
 * exactly what this test is about, and a parser would normalise away the
 * distinction between a job-level and a step-level declaration.
 */
export function jobsOf(text: string): Job[] {
  const lines = text.split('\n')
  const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l))
  if (jobsAt === -1) return []

  const heads: Array<{ name: string; at: number }> = []
  for (let i = jobsAt + 1; i < lines.length; i += 1) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(lines[i]!)
    if (m) heads.push({ name: m[1]!, at: i })
  }

  return heads.map((head, i) => {
    const end = i + 1 < heads.length ? heads[i + 1]!.at : lines.length
    const body = lines.slice(head.at, end)

    const jobEnv: Record<string, string> = {}
    let inJobEnv = false
    for (const line of body) {
      if (/^ {4}env:\s*$/.test(line)) {
        inJobEnv = true
        continue
      }
      // Any other key at job level closes the block.
      if (inJobEnv && /^ {4}\S/.test(line)) inJobEnv = false
      const entry = /^ {6}([A-Za-z0-9_]+):\s*(.*)$/.exec(line)
      if (inJobEnv && entry) jobEnv[entry[1]!] = entry[2]!.trim()
    }

    const stepEnvKeys = body
      .map((line) => /^ {10}([A-Za-z0-9_]+):/.exec(line)?.[1])
      .filter((k): k is string => Boolean(k))

    return { name: head.name, body: body.join('\n'), jobEnv, stepEnvKeys }
  })
}

/** Every way this can go wrong, in one place, so the fixture below can use it too. */
export function basePathViolations(text: string): string[] {
  const problems: string[] = []
  for (const job of jobsOf(text)) {
    if (job.stepEnvKeys.includes('VITE_BASE_PATH')) {
      problems.push(`${job.name}: VITE_BASE_PATH is declared on a step, where it can drift`)
    }
    const builds = job.body.includes(BUILD_WEB)
    const tests = job.body.includes(TEST_WEB)
    if (builds && tests && !job.jobEnv['VITE_BASE_PATH']) {
      problems.push(
        `${job.name}: builds and tests the web app but declares no job-level VITE_BASE_PATH`,
      )
    }
  }
  return problems
}

describe('the base path is a property of the job', () => {
  test.each(['ci.yml', 'deploy-web.yml', 'deploy-cloudflare.yml'])(
    '%s declares it once per job and never on a step',
    (file) => {
      expect(basePathViolations(read(file))).toEqual([])
    },
  )

  test('the Pages test job builds and tests at the same subpath', () => {
    const job = jobsOf(read('deploy-web.yml')).find((j) => j.name === 'test')!
    expect(job.body).toContain(BUILD_WEB)
    expect(job.body).toContain(TEST_WEB)
    expect(job.jobEnv['VITE_BASE_PATH']).toBe('/coffee-sub-tracker/')
  })

  test('the Pages artifact ships from the same subpath it was gated at', () => {
    const jobs = jobsOf(read('deploy-web.yml'))
    for (const name of ['test', 'build']) {
      expect(jobs.find((j) => j.name === name)!.jobEnv['VITE_BASE_PATH']).toBe(
        '/coffee-sub-tracker/',
      )
    }
  })

  test('Cloudflare gates and ships at the root', () => {
    const jobs = jobsOf(read('deploy-cloudflare.yml'))
    for (const name of ['test', 'deploy']) {
      expect(jobs.find((j) => j.name === name)!.jobEnv['VITE_BASE_PATH']).toBe('/')
    }
  })

  test('CI is explicit rather than relying on the unset default', () => {
    const job = jobsOf(read('ci.yml')).find((j) => j.name === 'test')!
    expect(job.jobEnv['VITE_BASE_PATH']).toBe('/coffee-sub-tracker/')
  })
})

describe('the check itself catches the shape that broke run 33708101869', () => {
  // The failing workflow, reduced to the part that mattered.
  const BROKEN = `
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Build web
        env:
          VITE_BASE_PATH: /coffee-sub-tracker/
        run: npm run build -w @coffee-sub/web

      - name: Web tests
        run: npm test -w @coffee-sub/web
`

  test('it reports both the step-level declaration and the missing job-level one', () => {
    const problems = basePathViolations(BROKEN)
    expect(problems).toHaveLength(2)
    expect(problems.join('\n')).toMatch(/declared on a step/)
    expect(problems.join('\n')).toMatch(/no job-level VITE_BASE_PATH/)
  })

  test('and passes the same workflow once the value moves to the job', () => {
    const fixed = `
jobs:
  test:
    runs-on: ubuntu-latest
    env:
      VITE_BASE_PATH: /coffee-sub-tracker/
    steps:
      - name: Build web
        run: npm run build -w @coffee-sub/web

      - name: Web tests
        run: npm test -w @coffee-sub/web
`
    expect(basePathViolations(fixed)).toEqual([])
  })
})
