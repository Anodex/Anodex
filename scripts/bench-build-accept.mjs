// The acceptance suite for the build benchmark. Hidden from the run: it is
// never written into the workspace, so nothing can be written to satisfy the
// tests rather than the spec.
//
// Every check runs the real `cli.js` in a child process and reads what came
// back, because "it looks right" has been wrong here before — a plan can be
// completed, a file can exist and be import-broken, and a summary can claim
// all four commands work when one throws on load.
//
// Usage: node scripts/bench-build-accept.mjs <workspace> [--json]
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** Run `node cli.js ...` in a built workspace and capture everything. */
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

/** A second log, written per-check, so a command cannot be tuned to one file. */
function withLog(root, name, lines) {
  const file = path.join(root, `__bench-${name}.log`)
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8')
  return `__bench-${name}.log`
}

const SAMPLE = 'samples/app.log'

export const ACCEPTANCE = [
  // ---- stats ----
  {
    command: 'stats',
    name: 'counts well-formed lines and skips the malformed one',
    run(root) {
      const out = json(cli(root, ['stats', SAMPLE]).stdout)
      return out?.total === 8 && out?.skipped === 1
    }
  },
  {
    command: 'stats',
    name: 'counts by level',
    run(root) {
      const out = json(cli(root, ['stats', SAMPLE]).stdout)
      return (
        out?.byLevel?.ERROR === 2 &&
        out?.byLevel?.INFO === 4 &&
        out?.byLevel?.WARN === 1 &&
        out?.byLevel?.FATAL === 1
      )
    }
  },
  {
    command: 'stats',
    name: 'omits levels that never appear',
    run(root) {
      const out = json(cli(root, ['stats', SAMPLE]).stdout)
      return out !== null && !('DEBUG' in (out.byLevel ?? {}))
    }
  },
  {
    command: 'stats',
    name: 'counts by component',
    run(root) {
      const out = json(cli(root, ['stats', SAMPLE]).stdout)
      return (
        out?.byComponent?.auth === 2 && out?.byComponent?.db === 4 && out?.byComponent?.api === 2
      )
    }
  },
  {
    command: 'stats',
    name: 'sorts both key sets alphabetically',
    run(root) {
      const out = json(cli(root, ['stats', SAMPLE]).stdout)
      if (!out) return false
      const sorted = (o) => {
        const keys = Object.keys(o ?? {})
        return JSON.stringify(keys) === JSON.stringify([...keys].sort())
      }
      return sorted(out.byLevel) && sorted(out.byComponent)
    }
  },
  {
    command: 'stats',
    name: 'handles a log with nothing well-formed in it',
    run(root) {
      const file = withLog(root, 'junk', ['not a log line', 'nor this one'])
      const out = json(cli(root, ['stats', file]).stdout)
      return out?.total === 0 && out?.skipped === 2
    }
  },

  // ---- filter ----
  {
    command: 'filter',
    name: 'prints matching lines verbatim, in order',
    run(root) {
      const out = cli(root, ['filter', SAMPLE, '--level=ERROR'])
      const lines = out.stdout.trim().split(/\r?\n/)
      return (
        out.code === 0 &&
        lines.length === 2 &&
        lines[0] === '2026-09-20T14:03:11Z ERROR auth Failed login for user 4821' &&
        lines[1] === '2026-09-20T16:01:09Z ERROR db Connection reset'
      )
    }
  },
  {
    command: 'filter',
    name: 'accepts a level in any case',
    run(root) {
      const a = cli(root, ['filter', SAMPLE, '--level=error']).stdout.trim()
      const b = cli(root, ['filter', SAMPLE, '--level=ERROR']).stdout.trim()
      return a.length > 0 && a === b
    }
  },
  {
    command: 'filter',
    name: 'narrows by component',
    run(root) {
      const out = cli(root, ['filter', SAMPLE, '--level=INFO', '--component=api'])
      const lines = out.stdout.trim().split(/\r?\n/).filter(Boolean)
      return out.code === 0 && lines.length === 2 && lines.every((l) => l.includes(' api '))
    }
  },
  {
    command: 'filter',
    name: 'rejects an unknown level with exit code 2',
    run(root) {
      const out = cli(root, ['filter', SAMPLE, '--level=NOISY'])
      return out.code === 2 && /unknown level/i.test(out.stderr)
    }
  },
  {
    command: 'filter',
    name: 'no matches is success with no output, not an error',
    run(root) {
      const out = cli(root, ['filter', SAMPLE, '--level=DEBUG'])
      return out.code === 0 && out.stdout.trim() === ''
    }
  },

  // ---- timeline ----
  {
    command: 'timeline',
    name: 'buckets by hour and labels buckets by their start',
    run(root) {
      const out = json(cli(root, ['timeline', SAMPLE, '--bucket=hour']).stdout)
      return Array.isArray(out) && out[0]?.bucket === '2026-09-20T14:00Z' && out[0]?.count === 4
    }
  },
  {
    command: 'timeline',
    name: 'includes the empty hour in the middle',
    run(root) {
      const out = json(cli(root, ['timeline', SAMPLE, '--bucket=hour']).stdout)
      if (!Array.isArray(out) || out.length !== 3) return false
      return out[1]?.bucket === '2026-09-20T15:00Z' && out[1]?.count === 0
    }
  },
  {
    command: 'timeline',
    name: 'is sorted ascending',
    run(root) {
      const out = json(cli(root, ['timeline', SAMPLE, '--bucket=hour']).stdout)
      if (!Array.isArray(out)) return false
      const labels = out.map((b) => b.bucket)
      return JSON.stringify(labels) === JSON.stringify([...labels].sort())
    }
  },
  {
    command: 'timeline',
    name: 'defaults to hour when --bucket is missing',
    run(root) {
      const a = cli(root, ['timeline', SAMPLE]).stdout.trim()
      const b = cli(root, ['timeline', SAMPLE, '--bucket=hour']).stdout.trim()
      return a.length > 0 && a === b
    }
  },
  {
    command: 'timeline',
    name: 'buckets by minute when asked',
    run(root) {
      const file = withLog(root, 'minute', [
        '2026-09-20T14:03:11Z INFO db one',
        '2026-09-20T14:03:59Z INFO db two',
        '2026-09-20T14:05:00Z INFO db three'
      ])
      const out = json(cli(root, ['timeline', file, '--bucket=minute']).stdout)
      if (!Array.isArray(out) || out.length !== 3) return false
      return (
        out[0]?.bucket === '2026-09-20T14:03:00Z' &&
        out[0]?.count === 2 &&
        out[1]?.count === 0 &&
        out[2]?.bucket === '2026-09-20T14:05:00Z'
      )
    }
  },
  {
    command: 'timeline',
    name: 'rejects an unknown bucket with exit code 2',
    run(root) {
      const out = cli(root, ['timeline', SAMPLE, '--bucket=fortnight'])
      return out.code === 2 && /unknown bucket/i.test(out.stderr)
    }
  },
  {
    command: 'timeline',
    name: 'an empty log is an empty array, not a crash',
    run(root) {
      const file = withLog(root, 'empty', ['not a log line'])
      const out = cli(root, ['timeline', file, '--bucket=hour'])
      return out.code === 0 && JSON.stringify(json(out.stdout)) === '[]'
    }
  },

  // ---- top ----
  {
    command: 'top',
    name: 'ranks messages by frequency',
    run(root) {
      const out = json(cli(root, ['top', SAMPLE, '--n=5']).stdout)
      return Array.isArray(out) && out[0]?.message === 'Connection reset' && out[0]?.count === 3
    }
  },
  {
    command: 'top',
    name: 'breaks ties alphabetically',
    run(root) {
      // Asserted over the whole array rather than one tied group: with five
      // entries the sample has exactly one message at each of 3 and 2, so a
      // check that looked only at those would pass on any ordering at all.
      const out = json(cli(root, ['top', SAMPLE, '--n=5']).stdout)
      if (!Array.isArray(out) || out.length !== 5) return false
      const expected = [...out].sort(
        (a, b) => b.count - a.count || a.message.localeCompare(b.message)
      )
      return JSON.stringify(out) === JSON.stringify(expected)
    }
  },
  {
    command: 'top',
    name: 'honours --n',
    run(root) {
      const out = json(cli(root, ['top', SAMPLE, '--n=2']).stdout)
      return Array.isArray(out) && out.length === 2
    }
  },
  {
    command: 'top',
    name: '--n=0 prints an empty array',
    run(root) {
      const out = cli(root, ['top', SAMPLE, '--n=0'])
      return out.code === 0 && JSON.stringify(json(out.stdout)) === '[]'
    }
  },
  {
    command: 'top',
    name: 'defaults to ten',
    run(root) {
      const lines = []
      for (let i = 0; i < 14; i++) lines.push(`2026-09-20T14:0${i % 10}:00Z INFO db message ${i}`)
      const file = withLog(root, 'many', lines)
      const out = json(cli(root, ['top', file]).stdout)
      return Array.isArray(out) && out.length === 10
    }
  },
  {
    command: 'top',
    name: 'prints fewer than asked when there are fewer',
    run(root) {
      const file = withLog(root, 'few', ['2026-09-20T14:00:00Z INFO db only one'])
      const out = json(cli(root, ['top', file, '--n=5']).stdout)
      return Array.isArray(out) && out.length === 1
    }
  },

  // ---- the seams ----
  {
    command: 'whole',
    name: 'the supplied dispatcher was not modified',
    run(root, { originalCli }) {
      return fs.readFileSync(path.join(root, 'cli.js'), 'utf8') === originalCli
    }
  },
  {
    command: 'whole',
    name: 'nothing imports outside the standard library',
    run(root) {
      const dir = path.join(root, 'commands')
      if (!fs.existsSync(dir)) return false
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'))
      if (files.length === 0) return false
      return files.every((f) => {
        const text = fs.readFileSync(path.join(dir, f), 'utf8')
        const imports = [...text.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1])
        return imports.every((i) => i.startsWith('.') || i.startsWith('node:'))
      })
    }
  },
  {
    command: 'whole',
    name: 'all four commands load and run without throwing',
    run(root) {
      return ['stats', 'filter', 'timeline', 'top'].every((c) => {
        const args = c === 'filter' ? [c, SAMPLE, '--level=INFO'] : [c, SAMPLE]
        const out = cli(root, args)
        // A module that fails to import exits non-zero with a stack trace; a
        // command that legitimately declines does not mention one.
        return !/Error|Cannot find|SyntaxError/.test(out.stderr)
      })
    }
  }
]

export function score(root, originalCli) {
  const results = ACCEPTANCE.map((check) => {
    let passed = false
    let error = null
    try {
      passed = check.run(root, { originalCli }) === true
    } catch (problem) {
      error = String(problem?.message ?? problem)
    }
    return { command: check.command, name: check.name, passed, error }
  })
  // Leave the workspace as it was found, minus the logs this suite wrote.
  for (const file of fs.readdirSync(root)) {
    if (file.startsWith('__bench-')) fs.rmSync(path.join(root, file), { force: true })
  }
  return results
}

if (process.argv[1] && process.argv[1].endsWith('bench-build-accept.mjs')) {
  const root = process.argv[2]
  if (!root) {
    console.error('usage: node scripts/bench-build-accept.mjs <workspace> [--json]')
    process.exit(1)
  }
  const { writeWorkspace } = await import('./bench-build-fixture.mjs')
  // The pristine dispatcher, to compare against whatever is in the workspace.
  const reference = path.join(process.env.TEMP ?? '.', `logtool-reference-${Date.now()}`)
  writeWorkspace(reference)
  const originalCli = fs.readFileSync(path.join(reference, 'cli.js'), 'utf8')
  fs.rmSync(reference, { recursive: true, force: true })

  const results = score(root, originalCli)
  const passed = results.filter((r) => r.passed).length
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ root, passed, total: results.length, results }, null, 2))
  } else {
    for (const r of results) {
      console.log(`${r.passed ? 'PASS' : 'FAIL'}  ${r.command.padEnd(9)} ${r.name}`)
      if (r.error) console.log(`      ${r.error}`)
    }
    console.log(`\n${passed} of ${results.length} acceptance checks pass`)
  }
}
