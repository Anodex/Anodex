// One-off: tally assessment verdicts for the newest run, to see whether the
// model will call a step sufficient rather than always continuing.
import fs from 'node:fs'
import path from 'node:path'

const file = path.join(process.env.APPDATA, 'anodex', 'critical-thinking', 'runs.json')
const run = Object.values(JSON.parse(fs.readFileSync(file, 'utf8'))).sort(
  (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)
)[0]

const tally = {}
let rounds = 0
for (const step of run.steps ?? []) {
  for (const round of step.rounds ?? []) {
    const verdict = round.assessment?.verdict
    if (!verdict) continue
    rounds++
    tally[verdict] = (tally[verdict] ?? 0) + 1
  }
}
console.log('status:', run.status)
console.log(
  'steps completed:',
  (run.steps ?? []).filter((s) => s.status === 'completed').length,
  'of',
  (run.steps ?? []).length
)
console.log('assessed rounds:', rounds, '| verdicts:', JSON.stringify(tally))
