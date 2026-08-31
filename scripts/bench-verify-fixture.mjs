// Prove every seeded defect is individually caught by the checks.
//
// Written after making the same mistake twice. Verifying that "all fixes
// applied -> everything passes" says nothing about whether each defect is
// detectable on its own: a check can pass against broken code because the
// inputs happen not to expose it. Both fixtures shipped with a defect the
// checks could not see - a discount on a quantity that divided evenly, so the
// float and integer paths agreed to the penny.
//
// This applies the fixes one at a time in reverse: with exactly one defect left
// in place, the suite must fail. If it passes, that defect is invisible and the
// benchmark is scoring something it cannot measure.
//
// Usage: node scripts/bench-verify-fixture.mjs
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeInventoryFixture } from './bench-fixtures.mjs'

/** Each seeded defect, and the edit that repairs exactly that one. */
const FIXES = [
  {
    name: 'models.total_value uses the wrong field',
    file: 'inventory/models.py',
    from: 'total += item.unit_pence * item.reorder_level',
    to: 'total += item.unit_pence * self._counts[sku]'
  },
  {
    name: 'pricing tier boundary is exclusive',
    file: 'inventory/pricing.py',
    from: 'if quantity > threshold:',
    to: 'if quantity >= threshold:'
  },
  {
    name: 'pricing discounts with float division',
    file: 'inventory/pricing.py',
    from: 'return int(gross - (gross * percent / 100.0))',
    to: 'return gross - (gross * percent) // 100'
  },
  {
    name: 'stock.remove_stock allows a negative count',
    file: 'inventory/stock.py',
    from: '    current = warehouse.count(sku)\n    warehouse.set_count(sku, current - quantity)',
    to:
      '    current = warehouse.count(sku)\n    if quantity > current:\n' +
      '        raise StockError("not enough stock")\n' +
      '    warehouse.set_count(sku, current - quantity)'
  },
  {
    name: 'report.top_by_value sorts by sku',
    file: 'inventory/report.py',
    from: 'key=lambda sku: sku, reverse=True',
    to: 'key=lambda sku: _value_of(warehouse, sku), reverse=True'
  }
]

function build(skipIndex) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anodex-fixture-check-'))
  writeInventoryFixture(root)
  FIXES.forEach((fix, index) => {
    if (index === skipIndex) return
    const file = path.join(root, fix.file)
    const before = fs.readFileSync(file, 'utf8')
    if (!before.includes(fix.from)) {
      throw new Error(`fix ${index + 1} no longer applies: ${fix.from.slice(0, 40)}`)
    }
    fs.writeFileSync(file, before.replace(fix.from, fix.to), 'utf8')
  })
  return root
}

function suitePasses(root) {
  try {
    execFileSync('python', ['test_inventory.py'], { cwd: root, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

let bad = 0

// Every fix applied: the suite must pass, or the task is unsolvable.
const solved = build(-1)
if (suitePasses(solved)) {
  console.log('ok   solvable: all fixes applied, every check passes')
} else {
  console.log('FAIL solvable: the intended fixes do not satisfy the checks')
  bad++
}
fs.rmSync(solved, { recursive: true, force: true })

// One defect left in at a time: the suite must fail each time.
FIXES.forEach((fix, index) => {
  const root = build(index)
  if (suitePasses(root)) {
    console.log(`FAIL invisible: nothing catches "${fix.name}"`)
    bad++
  } else {
    console.log(`ok   caught: ${fix.name}`)
  }
  fs.rmSync(root, { recursive: true, force: true })
})

console.log(bad === 0 ? 'FIXTURE VERIFIED' : `${bad} PROBLEM(S)`)
process.exit(bad === 0 ? 0 : 1)
