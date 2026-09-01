// Prove the long fixture is solvable, and that every seeded defect is caught.
//
// A benchmark nobody has solved is not a benchmark. Two of the earlier fixtures
// shipped impossible: bench-4's `top_by_value` had a tie with no defined
// winner, and two discount tests used a gross divisible by 100, which hid the
// float defect they existed to catch. Both were only found by trying to solve
// them.
//
// This applies the known fix for each of the sixteen defects and asserts the
// suite then passes completely. It also re-runs the unfixed fixture first, so a
// fixture that had silently stopped failing would be caught too.
//
// Usage: node scripts/bench-verify-long.mjs
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeLongTaskFixture } from './bench-fixtures-long.mjs'

/** The one-line repair for each seeded defect, as [file, wrong, right]. */
const FIXES = [
  ['rectangles.py', 'return width + height', 'return 2 * (width + height)'],
  ['circles.py', 'math.pi * (radius * 2) ** 2', 'math.pi * radius ** 2'],
  ['triangles.py', 'return base * height', 'return base * height / 2'],
  [
    'points.py',
    'return ((first[0] + second[0]) / 2, (first[0] + second[0]) / 2)',
    'return ((first[0] + second[0]) / 2, (first[1] + second[1]) / 2)'
  ],
  [
    'ranges.py',
    'return first[0] > second[1] or second[0] > first[1]',
    'return not (first[0] > second[1] or second[0] > first[1])'
  ],
  [
    'polygons.py',
    '    for index in range(len(vertices) - 1):\n        total += distance(vertices[index], vertices[index + 1])\n    return total',
    '    for index in range(len(vertices)):\n        total += distance(vertices[index], vertices[(index + 1) % len(vertices)])\n    return total'
  ],
  ['conversions.py', 'return radians * 180 / math.tau', 'return radians * 180 / math.pi'],
  [
    'vectors.py',
    'return first[0] * second[1] + first[1] * second[0]',
    'return first[0] * second[0] + first[1] * second[1]'
  ],
  ['grids.py', 'return column * width + row', 'return row * width + column'],
  [
    'bounds.py',
    'return (max(xs), max(ys), max(xs), max(ys))',
    'return (min(xs), min(ys), max(xs), max(ys))'
  ],
  [
    'scaling.py',
    'return min(1.0, max(box[0] / size[0], box[1] / size[1]))',
    'return min(1.0, min(box[0] / size[0], box[1] / size[1]))'
  ],
  [
    'rounding.py',
    'return math.floor(value / step) * step',
    'return round_half_up(value / step) * step'
  ],
  ['paths.py', 'return points[0] == points[0]', 'return points[0] == points[-1]'],
  ['angles.py', 'while degrees > 360:', 'while degrees >= 360:'],
  [
    'areas.py',
    'return min(sizes, key=lambda size: rect_area(size[0], size[1]))',
    'return max(sizes, key=lambda size: rect_area(size[0], size[1]))'
  ],
  ['summaries.py', '    lines = shapes', '    lines = list(shapes)']
]

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-long-'))
try {
  writeLongTaskFixture(root)

  const before = runSuite(root)
  if (before.passed) {
    fail('The unfixed fixture passes its own suite. The defects are not being seeded.')
  }
  console.log(`unfixed: ${before.summary}`)

  for (const [file, wrong, right] of FIXES) {
    const target = path.join(root, 'geometry', file)
    const source = fs.readFileSync(target, 'utf8')
    if (!source.includes(wrong))
      fail(`${file}: the seeded defect is not present. Looked for:\n${wrong}`)
    fs.writeFileSync(target, source.replace(wrong, right), 'utf8')
  }

  const after = runSuite(root)
  console.log(`  fixed: ${after.summary}`)
  if (!after.passed) fail(`The fixture is not solvable by its own known fixes.\n${after.output}`)

  console.log(`\nOK: ${FIXES.length} defects seeded, all caught, and the suite passes once fixed.`)
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}

function runSuite(cwd) {
  try {
    const output = execFileSync('python', ['test_geometry.py'], { cwd, encoding: 'utf8' })
    return { passed: true, output, summary: summarise(output) }
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`
    return { passed: false, output, summary: summarise(output) }
  }
}

function summarise(output) {
  return output.split('\n').find((line) => line.includes('checks passed')) ?? '(no summary line)'
}

function fail(message) {
  console.error(`\nFAILED: ${message}`)
  process.exit(1)
}
