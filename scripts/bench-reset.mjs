// Put the benchmark project back to a known state before a run.
//
// Statistics are only comparable if every run starts from the same place. The
// Universe Sandbox workload cannot give that: it accumulates, so the second run
// of a task finds the feature already built and measures something else
// entirely. That happened - a "regression test" finished in five turns because
// an earlier session had already done the work.
//
// Usage: node scripts/bench-reset.mjs <bench-name>
import fs from 'node:fs'
import path from 'node:path'
import { writeInventoryFixture, writeRustFixture } from './bench-fixtures.mjs'
import { writeLongTaskFixture } from './bench-fixtures-long.mjs'

const ROOT = path.join('C:', 'Users', 'Owner', 'Desktop', 'Sandbox', 'Bench')
// A `-small` spec is the same benchmark with a turn budget sized for a small
// context window, so it needs the same fixture. Stripping the suffix here keeps
// that fact in one place rather than in every caller.
const name = (process.argv[2] ?? '').replace(/-small$/, '')

// Refuse to empty anything that is not the benchmark folder. This deletes
// files, so it checks rather than trusts.
if (path.basename(ROOT) !== 'Bench') {
  console.error('Refusing to clear a folder that is not the benchmark folder:', ROOT)
  process.exit(1)
}

// Refuse while a run is using it. There is one benchmark folder, so resetting
// it mid-run deletes the files the model is working on and voids the
// measurement without anything saying so.
//
// This happened: a fixture was verified here while a run was live, and the run
// carried on against a workspace that had turned into a different project
// underneath it. The model noticed and said so, which is the only reason it was
// caught. `--force` exists for a wedged run whose record never settled.
const RUNS = path.join(process.env.APPDATA ?? '', 'anodex', 'agent-runs', 'runs.json')
if (!process.argv.includes('--force') && fs.existsSync(RUNS)) {
  try {
    const active = JSON.parse(fs.readFileSync(RUNS, 'utf8')).filter(
      (run) => run.status === 'running'
    )
    if (active.length > 0) {
      console.error(
        `Refusing to reset: ${active.length} agent run(s) still running (${active
          .map((run) => run.id)
          .join(', ')}).\n` +
          'Resetting now would delete the workspace out from under them. Wait for the run to\n' +
          'finish, or pass --force if you know its record is stale.'
      )
      process.exit(1)
    }
  } catch {
    // An unreadable or half-written store is not a reason to refuse a reset —
    // it only means this particular safeguard cannot answer.
  }
}

fs.mkdirSync(ROOT, { recursive: true })
for (const entry of fs.readdirSync(ROOT)) {
  // `.anodex` holds the project's own bookkeeping, not the run's work.
  if (entry === '.anodex') continue
  fs.rmSync(path.join(ROOT, entry), { recursive: true, force: true })
}

/**
 * The fix-existing task needs something broken to fix. Three defects, each of a
 * different kind, none of them a syntax error the model could find by running
 * the file alone:
 *   1. `parse_pairs` splits on the wrong separator.
 *   2. `to_int` swallows the sign.
 *   3. `merge` mutates the dictionary it is given.
 */
if (name === 'bench-3-fix-existing') {
  fs.writeFileSync(
    path.join(ROOT, 'parser.py'),
    [
      'def parse_pairs(text):',
      '    """Parse "a=1;b=2" into {"a": "1", "b": "2"}."""',
      '    out = {}',
      '    for chunk in text.split(","):',
      '        if not chunk:',
      '            continue',
      '        key, _, value = chunk.partition("=")',
      '        out[key.strip()] = value.strip()',
      '    return out',
      '',
      '',
      'def to_int(value):',
      '    """Convert a string to an int, allowing a leading + or -."""',
      '    digits = "".join(c for c in value if c.isdigit())',
      '    if not digits:',
      '        raise ValueError("no digits in %r" % value)',
      '    return int(digits)',
      '',
      '',
      'def merge(base, extra):',
      '    """Return a new dict with extra applied over base."""',
      '    base.update(extra)',
      '    return base',
      ''
    ].join('\n'),
    'utf-8'
  )
  fs.writeFileSync(
    path.join(ROOT, 'test_parser.py'),
    [
      'import parser',
      '',
      'checks = 0',
      '',
      '',
      'def check(ok, what):',
      '    global checks',
      '    assert ok, "FAILED: " + what',
      '    checks += 1',
      '    print("OK: " + what)',
      '',
      '',
      'check(parser.parse_pairs("a=1;b=2") == {"a": "1", "b": "2"}, "pairs are separated by ;")',
      'check(parser.to_int("-42") == -42, "to_int keeps a negative sign")',
      'check(parser.to_int("+7") == 7, "to_int accepts a leading plus")',
      '',
      'original = {"a": 1}',
      'merged = parser.merge(original, {"b": 2})',
      'check(merged == {"a": 1, "b": 2}, "merge applies extra over base")',
      'check(original == {"a": 1}, "merge does not mutate the dict it is given")',
      '',
      'print("ALL CHECKS PASSED (%d)" % checks)',
      ''
    ].join('\n'),
    'utf-8'
  )
}

if (name === 'bench-4-large-multi-file') {
  writeInventoryFixture(ROOT)
}

if (name === 'bench-5-rust') {
  writeRustFixture(ROOT)
}

if (name === 'bench-6-long') {
  writeLongTaskFixture(ROOT)
}

console.log(`Bench reset for ${name || '(empty project)'} at ${ROOT}`)
