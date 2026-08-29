// One-off: report the four clean-run criteria for every stored run.
//   1. selectedStage is draft or repair (the model's own report)
//   2. every step completed where evidence exists
//   3. status completed
//   4. zero excerpt-dump blocks in the shipped report
import fs from 'node:fs'
import path from 'node:path'

const file = path.join(process.env.APPDATA, 'anodex', 'critical-thinking', 'runs.json')
const runs = Object.values(JSON.parse(fs.readFileSync(file, 'utf8'))).sort(
  (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)
)

const only = process.argv[2] ? Number(process.argv[2]) : null

// An excerpt-dump block is the assembled-fallback shape: a source heading
// followed by a raw passage, rather than prose answering the question.
const dumpBlocks = (report) => {
  if (!report) return 0
  let n = 0
  for (const line of report.split('\n')) {
    if (/^\s*>\s*\S/.test(line)) n++
    if (/^#{1,6}\s+(Excerpt|Passage|Raw|Source \d)/i.test(line)) n++
  }
  return n
}

for (const [i, run] of runs.entries()) {
  if (only !== null && i + 1 !== only) continue
  const d = run.synthesisDiagnostics ?? {}
  const steps = run.steps ?? []
  const done = steps.filter((s) => s.status === 'completed').length
  const tally = {}
  let rounds = 0
  for (const step of steps)
    for (const round of step.rounds ?? []) {
      const v = round.assessment?.verdict
      if (!v) continue
      rounds++
      tally[v] = (tally[v] ?? 0) + 1
    }
  const suff = rounds ? Math.round(((tally.sufficient ?? 0) / rounds) * 100) : 0
  // Runs recorded before the chart fix stored `selectedStage: 'chart'` when a
  // chart was appended, which overwrote the stage that wrote the prose. A chart
  // is only ever appended to the winning report, so for those older runs
  // 'chart' still means the model's own report -- it just no longer says which.
  const c1 =
    d.selectedStage === 'draft' || d.selectedStage === 'repair' || d.selectedStage === 'chart'
  const c2 = steps.length > 0 && done === steps.length
  const c3 = run.status === 'completed'
  const c4 = dumpBlocks(run.report) === 0
  const clean = c1 && c2 && c3 && c4
  console.log(
    [
      `run ${String(i + 1).padStart(2)}`,
      new Date(run.createdAt ?? 0).toISOString().slice(5, 16),
      clean ? 'CLEAN  ' : 'not-clean',
      `stage=${String(d.selectedStage).padEnd(8)}${d.chartAdded ? '+chart' : '      '}${c1 ? '+' : '-'}`,
      `steps=${done}/${steps.length}${c2 ? '+' : '-'}`,
      `status=${String(run.status).padEnd(9)}${c3 ? '+' : '-'}`,
      `dumps=${dumpBlocks(run.report)}${c4 ? '+' : '-'}`,
      `suff=${suff}%`,
      `chars=${(run.report ?? '').length}`
    ].join('  ')
  )
  const blockers = d.completion?.blockers
  if (blockers?.length)
    console.log('    blockers:', blockers.join(', '), '|', JSON.stringify(d.completion))
  if (process.env.VERBOSE) {
    console.log('    question:', (run.question ?? '').slice(0, 100))
    for (const a of d.attempts ?? [])
      console.log(
        `    ${a.stage}: chars=${a.contentChars} valid=${a.valid} issues=${(a.issues ?? []).length}`
      )
  }
}
