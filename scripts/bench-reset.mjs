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

const ROOT = path.join('C:', 'Users', 'Owner', 'Desktop', 'Sandbox', 'Bench')
const name = process.argv[2] ?? ''

// Refuse to empty anything that is not the benchmark folder. This deletes
// files, so it checks rather than trusts.
if (path.basename(ROOT) !== 'Bench') {
  console.error('Refusing to clear a folder that is not the benchmark folder:', ROOT)
  process.exit(1)
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

console.log(`Bench reset for ${name || '(empty project)'} at ${ROOT}`)
