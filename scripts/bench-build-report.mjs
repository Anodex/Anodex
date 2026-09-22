// Grade the archived workspaces and print the table.
//
// Scoring happens here rather than in the sweep so a sweep that dies overnight
// still leaves something gradeable, and so the rubric can be re-run against
// every archived workspace after it is corrected — which has been needed
// before.
//
// Usage: node scripts/bench-build-report.mjs [--verbose]
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { writeWorkspace } from './bench-build-fixture.mjs'
import { score, ACCEPTANCE } from './bench-build-accept.mjs'

const RESULTS = path.join('scripts', 'bench-build-results.json')
const verbose = process.argv.includes('--verbose')

if (!fs.existsSync(RESULTS)) {
  console.error(`No results at ${RESULTS}. Run the sweep first.`)
  process.exit(1)
}
const runs = JSON.parse(fs.readFileSync(RESULTS, 'utf8'))

// The pristine dispatcher, to tell "did not touch cli.js" from "rewrote it".
const reference = path.join(os.tmpdir(), `logtool-reference-${Date.now()}`)
writeWorkspace(reference)
const originalCli = fs.readFileSync(path.join(reference, 'cli.js'), 'utf8')
fs.rmSync(reference, { recursive: true, force: true })

const graded = runs.map((run) => {
  if (!run.workspace || !fs.existsSync(run.workspace)) {
    // Louder than a zero. A missing workspace is a broken harness, and a
    // harness that reports a broken run as a failed one has lied before.
    return { ...run, passed: null, total: ACCEPTANCE.length, missing: true }
  }
  const results = score(run.workspace, originalCli)
  return {
    ...run,
    passed: results.filter((r) => r.passed).length,
    total: results.length,
    failures: results.filter((r) => !r.passed).map((r) => `${r.command}: ${r.name}`)
  }
})

const byArm = new Map()
for (const run of graded) {
  if (!byArm.has(run.arm)) byArm.set(run.arm, [])
  byArm.get(run.arm).push(run)
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

const LABEL = {
  'off-1job': 'solo, full window',
  'off-3jobs': 'solo, split window',
  'sub-1': '1 sub-agent',
  'sub-2': '2 sub-agents'
}

console.log(`\n| arm | runs | acceptance (median) | best | turns | minutes | tokens | children |`)
console.log(`| --- | --- | --- | --- | --- | --- | --- | --- |`)
for (const [arm, list] of byArm) {
  const scored = list.filter((r) => r.passed !== null)
  if (scored.length === 0) {
    console.log(`| ${LABEL[arm] ?? arm} | ${list.length} | workspace missing | | | | | |`)
    continue
  }
  const scores = scored.map((r) => r.passed)
  const mins = scored.map((r) => Math.round((r.activeMs ?? 0) / 60000))
  console.log(
    `| ${LABEL[arm] ?? arm} | ${scored.length} | ` +
      `**${median(scores)} of ${scored[0].total}** | ${Math.max(...scores)} | ` +
      `${median(scored.map((r) => r.turnsUsed ?? 0))} | ${median(mins)} | ` +
      `${median(scored.map((r) => r.tokensUsed ?? 0)).toLocaleString()} | ` +
      `${median(scored.map((r) => r.subAgents ?? 0))} |`
  )
}

const flagged = graded.filter((r) => (r.flaggedTurns ?? 0) > 0)
if (flagged.length > 0) {
  console.log(
    `\n${flagged.length} run(s) claimed an outcome that did not happen: ` +
      flagged.map((r) => `${r.arm}#${r.repeat} (${r.flaggedTurns})`).join(', ')
  )
}

if (verbose) {
  console.log('\n--- what each run failed ---')
  for (const run of graded) {
    if (run.passed === null) {
      console.log(`\n${run.arm} #${run.repeat}: workspace missing at ${run.workspace}`)
      continue
    }
    console.log(
      `\n${run.arm} #${run.repeat} — ${run.passed}/${run.total}, ${run.status ?? 'no run'}`
    )
    for (const failure of run.failures) console.log(`  FAIL ${failure}`)
  }
}
