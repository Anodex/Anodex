// The acceptance suite for the larger build workload. Never written into the
// workspace, so nothing can be built to satisfy the tests instead of the spec.
//
// Two kinds of check. The first is what every command prints, run through the
// real `cli.js` in a child process. The second is conformance: whether the new
// commands used the library that was already there or quietly reinvented it.
// That second kind is the whole reason this workload exists — filling in blank
// files does not test whether an agent can work inside someone else's code,
// and neither does a rubric that only reads stdout.
//
// Usage: node scripts/bench-build-large-accept.mjs <workspace> [--json]
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

function cli(root, args) {
  try {
    const stdout = execFileSync(process.execPath, ['cli.js', ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20_000
    })
    return { stdout, stderr: '', code: 0 }
  } catch (error) {
    return {
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? String(error.message ?? ''),
      code: typeof error.status === 'number' ? error.status : 1
    }
  }
}

const json = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const SAMPLE = 'samples/app.log'
const OTHER = 'samples/other.log'
const NEW = ['components', 'errors', 'rate', 'sessions', 'diff', 'tail']
const UNTOUCHABLE = [
  'cli.js',
  'lib/parse.js',
  'lib/render.js',
  'lib/time.js',
  'lib/errors.js',
  'commands/stats.js',
  'commands/filter.js',
  'commands/timeline.js',
  'commands/top.js'
]

const read = (root, rel) => {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8')
  } catch {
    return null
  }
}

export const ACCEPTANCE = [
  // ---- components ----
  {
    command: 'components',
    name: 'nests levels inside each component',
    run(root) {
      const out = json(cli(root, ['components', SAMPLE]).stdout)
      return (
        out?.auth?.total === 3 && out?.auth?.byLevel?.ERROR === 2 && out?.auth?.byLevel?.INFO === 1
      )
    }
  },
  {
    command: 'components',
    name: 'counts every component',
    run(root) {
      const out = json(cli(root, ['components', SAMPLE]).stdout)
      return (
        out?.api?.total === 3 &&
        out?.auth?.total === 3 &&
        out?.boot?.total === 4 &&
        out?.db?.total === 4
      )
    }
  },
  {
    command: 'components',
    name: 'sorts components and their levels alphabetically',
    run(root) {
      const out = json(cli(root, ['components', SAMPLE]).stdout)
      if (!out) return false
      const keys = Object.keys(out)
      if (JSON.stringify(keys) !== JSON.stringify([...keys].sort())) return false
      return keys.every((k) => {
        const levels = Object.keys(out[k].byLevel ?? {})
        return JSON.stringify(levels) === JSON.stringify([...levels].sort())
      })
    }
  },
  {
    command: 'components',
    name: 'honours --min',
    run(root) {
      const out = json(cli(root, ['components', SAMPLE, '--min=4']).stdout)
      return out !== null && JSON.stringify(Object.keys(out)) === JSON.stringify(['boot', 'db'])
    }
  },

  // ---- errors ----
  {
    command: 'errors',
    name: 'prints the error and fatal lines with no context',
    run(root) {
      const out = cli(root, ['errors', SAMPLE])
      const lines = out.stdout.trim().split(/\r?\n/)
      return (
        out.code === 0 &&
        lines.filter((l) => l !== '--').length === 4 &&
        lines.some((l) => l.includes('FATAL db Disk full'))
      )
    }
  },
  {
    command: 'errors',
    name: 'separates non-adjacent groups with --',
    run(root) {
      const lines = cli(root, ['errors', SAMPLE]).stdout.trim().split(/\r?\n/)
      // Three groups: the lone db error, the two adjacent auth errors merged,
      // and the lone fatal — so exactly two separators.
      return lines.filter((l) => l === '--').length === 2
    }
  },
  {
    command: 'errors',
    name: 'merges groups that touch once context widens them',
    run(root) {
      const out = cli(root, ['errors', SAMPLE, '--context=1'])
      const lines = out.stdout.trim().split(/\r?\n/)
      // At one line of context every group overlaps the next, so the whole
      // run collapses into one block with no separator at all.
      return out.code === 0 && lines.length === 9 && !lines.includes('--')
    }
  },
  {
    command: 'errors',
    name: 'rejects a --context that is not a whole number',
    run(root) {
      const out = cli(root, ['errors', SAMPLE, '--context=lots'])
      return out.code === 2
    }
  },
  {
    command: 'errors',
    name: 'a log with no errors is silent success',
    run(root) {
      const out = cli(root, ['errors', OTHER])
      return out.code === 0 && out.stdout.trim() === ''
    }
  },

  // ---- rate ----
  {
    command: 'rate',
    name: 'draws the table exactly as the render helpers do',
    run(root) {
      const out = cli(root, ['rate', SAMPLE, '--bucket=hour'])
      const expected = [
        '2026-09-20T09:00Z  7  ' + '█'.repeat(20),
        '2026-09-20T10:00Z  0',
        '2026-09-20T11:00Z  4  ' + '█'.repeat(12),
        '2026-09-20T12:00Z  0',
        '2026-09-20T13:00Z  3  ' + '█'.repeat(9)
      ].join('\n')
      return out.code === 0 && out.stdout.trim() === expected
    }
  },
  {
    command: 'rate',
    name: 'keeps the quiet buckets in the middle',
    run(root) {
      const lines = cli(root, ['rate', SAMPLE]).stdout.trim().split(/\r?\n/)
      return lines.length === 5
    }
  },
  {
    command: 'rate',
    name: 'rejects an unknown bucket',
    run(root) {
      const out = cli(root, ['rate', SAMPLE, '--bucket=fortnight'])
      return out.code === 2 && /unknown bucket/i.test(out.stderr)
    }
  },
  {
    command: 'rate',
    name: 'buckets by day when asked',
    run(root) {
      const out = cli(root, ['rate', SAMPLE, '--bucket=day'])
      const lines = out.stdout.trim().split(/\r?\n/).filter(Boolean)
      return out.code === 0 && lines.length === 1 && lines[0].startsWith('2026-09-20  14')
    }
  },

  // ---- sessions ----
  {
    command: 'sessions',
    name: 'splits on the default half-hour gap',
    run(root) {
      const out = json(cli(root, ['sessions', SAMPLE]).stdout)
      if (!Array.isArray(out) || out.length !== 3) return false
      return (
        out[0].start === '2026-09-20T09:00:00Z' &&
        out[0].end === '2026-09-20T09:03:20Z' &&
        out[0].entries === 7
      )
    }
  },
  {
    command: 'sessions',
    name: 'every entry lands in exactly one session',
    run(root) {
      const out = json(cli(root, ['sessions', SAMPLE]).stdout)
      if (!Array.isArray(out)) return false
      return out.reduce((sum, s) => sum + s.entries, 0) === 14
    }
  },
  {
    command: 'sessions',
    name: 'honours a tighter --gap',
    run(root) {
      const out = json(cli(root, ['sessions', SAMPLE, '--gap=1m']).stdout)
      if (!Array.isArray(out)) return false
      return (
        out.length === 4 &&
        JSON.stringify(out.map((s) => s.entries)) === JSON.stringify([2, 5, 4, 3])
      )
    }
  },
  {
    command: 'sessions',
    name: 'rejects a duration it does not understand',
    run(root) {
      const out = cli(root, ['sessions', SAMPLE, '--gap=soon'])
      return out.code === 2 && /unknown duration/i.test(out.stderr)
    }
  },

  // ---- diff ----
  {
    command: 'diff',
    name: 'compares totals in the right direction',
    run(root) {
      const out = json(cli(root, ['diff', SAMPLE, `--against=${OTHER}`]).stdout)
      return out?.total?.before === 14 && out?.total?.after === 5 && out?.total?.change === -9
    }
  },
  {
    command: 'diff',
    name: 'covers every level in either file, with zeroes where absent',
    run(root) {
      const out = json(cli(root, ['diff', SAMPLE, `--against=${OTHER}`]).stdout)
      if (!out?.byLevel) return false
      const keys = Object.keys(out.byLevel)
      return (
        JSON.stringify(keys) === JSON.stringify(['DEBUG', 'ERROR', 'FATAL', 'INFO', 'WARN']) &&
        out.byLevel.ERROR.after === 0 &&
        out.byLevel.ERROR.change === -3 &&
        out.byLevel.WARN.change === 0
      )
    }
  },
  {
    command: 'diff',
    name: 'a missing --against file fails rather than throwing',
    run(root) {
      const out = cli(root, ['diff', SAMPLE, '--against=samples/nope.log'])
      return out.code === 2 && /cannot read/i.test(out.stderr)
    }
  },
  {
    command: 'diff',
    name: 'reports a difference without treating it as a failure',
    run(root) {
      return cli(root, ['diff', SAMPLE, `--against=${OTHER}`]).code === 0
    }
  },

  // ---- tail ----
  {
    command: 'tail',
    name: 'prints the newest entries first',
    run(root) {
      const out = cli(root, ['tail', SAMPLE, '--n=3'])
      const lines = out.stdout.trim().split(/\r?\n/)
      return (
        out.code === 0 &&
        lines.length === 3 &&
        lines[0].includes('13:00:20Z DEBUG boot Flushed buffers') &&
        lines[2].includes('13:00:00Z FATAL db Disk full')
      )
    }
  },
  {
    command: 'tail',
    name: 'defaults to ten',
    run(root) {
      const lines = cli(root, ['tail', SAMPLE]).stdout.trim().split(/\r?\n/).filter(Boolean)
      return lines.length === 10
    }
  },
  {
    command: 'tail',
    name: 'filters before taking the last n',
    run(root) {
      const out = cli(root, ['tail', SAMPLE, '--n=2', '--level=ERROR'])
      const lines = out.stdout.trim().split(/\r?\n/).filter(Boolean)
      return (
        lines.length === 2 &&
        lines[0].includes('11:31:00Z ERROR auth') &&
        lines[1].includes('11:30:40Z ERROR auth')
      )
    }
  },
  {
    command: 'tail',
    name: '--n=0 prints nothing',
    run(root) {
      const out = cli(root, ['tail', SAMPLE, '--n=0'])
      return out.code === 0 && out.stdout.trim() === ''
    }
  },

  // ---- conformance: did it work inside the code that was already there? ----
  {
    command: 'seams',
    name: 'every new command exists',
    run(root) {
      return NEW.every((name) => read(root, `commands/${name}.js`) !== null)
    }
  },
  {
    command: 'seams',
    name: 'nothing that was already working was changed',
    run(root, { originals }) {
      // The library and the four worked examples are the ground everything
      // else stands on. A run that "fixed" them to suit its new command has
      // not extended this project, it has forked it.
      return UNTOUCHABLE.every((rel) => read(root, rel) === originals[rel])
    }
  },
  {
    command: 'seams',
    name: 'new commands use the shared parser instead of their own regex',
    run(root) {
      return NEW.every((name) => {
        const text = read(root, `commands/${name}.js`)
        if (text === null) return false
        // A second timestamp pattern anywhere is the fork this library exists
        // to prevent, whichever way it is spelled.
        return !/\\d\{4\}|\[0-9\]\{4\}/.test(text)
      })
    }
  },
  {
    command: 'seams',
    name: 'new commands import from lib/',
    run(root) {
      return NEW.every((name) => {
        const text = read(root, `commands/${name}.js`)
        return text !== null && /from\s+['"]\.\.\/lib\//.test(text)
      })
    }
  },
  {
    command: 'seams',
    name: 'nothing imports outside the standard library',
    run(root) {
      return NEW.every((name) => {
        const text = read(root, `commands/${name}.js`)
        if (text === null) return false
        const imports = [...text.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1])
        return imports.every((i) => i.startsWith('.') || i.startsWith('node:'))
      })
    }
  },
  {
    command: 'seams',
    name: 'all six load and run without throwing',
    run(root) {
      return NEW.every((name) => {
        const args = name === 'diff' ? [name, SAMPLE, `--against=${OTHER}`] : [name, SAMPLE]
        const out = cli(root, args)
        return !/Error|Cannot find|SyntaxError|is not a function/.test(out.stderr)
      })
    }
  }
]

export function score(root, originals) {
  const results = ACCEPTANCE.map((check) => {
    let passed = false
    let error = null
    try {
      passed = check.run(root, { originals }) === true
    } catch (problem) {
      error = String(problem?.message ?? problem)
    }
    return { command: check.command, name: check.name, passed, error }
  })
  return results
}

/** The pristine copies of everything the run was told not to change. */
export async function originalFiles() {
  const { writeWorkspace } = await import('./bench-build-large-fixture.mjs')
  const reference = path.join(process.env.TEMP ?? '.', `logtool-large-ref-${Date.now()}`)
  writeWorkspace(reference)
  const originals = {}
  for (const rel of UNTOUCHABLE) originals[rel] = read(reference, rel)
  fs.rmSync(reference, { recursive: true, force: true })
  return originals
}

if (process.argv[1] && process.argv[1].endsWith('bench-build-large-accept.mjs')) {
  const root = process.argv[2]
  if (!root) {
    console.error('usage: node scripts/bench-build-large-accept.mjs <workspace> [--json]')
    process.exit(1)
  }
  const results = score(root, await originalFiles())
  const passed = results.filter((r) => r.passed).length
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ root, passed, total: results.length, results }, null, 2))
  } else {
    for (const r of results) {
      console.log(`${r.passed ? 'PASS' : 'FAIL'}  ${r.command.padEnd(11)} ${r.name}`)
      if (r.error) console.log(`      ${r.error}`)
    }
    console.log(`\n${passed} of ${results.length} acceptance checks pass`)
  }
}
