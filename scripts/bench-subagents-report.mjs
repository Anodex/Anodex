// Turn the sweep's runs into the arm-by-arm comparison.
//
// Reports the median beside the mean, because with five runs an arm one of
// which collapsed has a mean that describes no run that happened, and the
// range beside both: if the arms overlap, the honest answer is "no measurable
// difference", and that is a result rather than a failure to produce one.
//
// Usage: node scripts/bench-subagents-report.mjs [--markdown]
import { ANSWER_KEY, scoreReport } from './bench-subagents-fixture.mjs'
import { armOf, bugHuntRuns, readJson, runText, toolCalls } from './bench-subagents-read.mjs'

const median = (xs) => {
  if (xs.length === 0) return 0
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const round = (n, places = 1) => Number(n.toFixed(places))

/**
 * Only the runs from the current sweep.
 *
 * The store keeps every bug-hunt run ever made, including the ones from
 * before `delegate` reached a model and the ones killed mid-flight while
 * clearing the app. Scoring those alongside real data does not dilute the
 * result, it invents one: a killed run reads as 0/12 and drags whichever arm
 * it belonged to. The sweep records the ids it started, so that file decides
 * what counts; without it, everything does and the report says so.
 */
function sweepRunIds() {
  const recorded = readJson('scripts/bench-subagents-results.json', null)
  if (!Array.isArray(recorded) || recorded.length === 0) return null
  return new Set(recorded.map((entry) => entry.runId).filter(Boolean))
}

/**
 * Which arm each run belongs to, as the sweep recorded it.
 *
 * Preferred over reading the goal, because two arms can share a goal: `off`
 * and `off-split` differ only in the engine settings they were launched
 * with, so inferring from prose collapsed them into one row and reported a
 * six-run arm that never existed.
 */
function recordedArms() {
  const recorded = readJson('scripts/bench-subagents-results.json', null)
  if (!Array.isArray(recorded)) return new Map()
  return new Map(recorded.filter((entry) => entry.runId).map((entry) => [entry.runId, entry.arm]))
}

const { all, parents: everyParent } = bugHuntRuns()
const only = sweepRunIds()
const parents = only ? everyParent.filter((run) => only.has(run.id)) : everyParent
if (!only) {
  console.log('(no sweep results file - scoring every bug-hunt run in the store)')
}
if (parents.length === 0) {
  console.error('No finished bug-hunt runs yet.')
  process.exit(1)
}

const armById = recordedArms()
const scored = parents.map((run) => {
  const children = all.filter((other) => other.parentRunId === run.id)
  const hits = scoreReport([run, ...children].map(runText).join('\n'))
  return {
    arm: armById.get(run.id) ?? armOf(run),
    runId: run.id,
    status: run.status,
    // What the model actually did, not what the arm asked for. An arm whose
    // runs never delegated is measuring the baseline under another name, and
    // saying so is the difference between a result and a mistake.
    subAgents: children.length,
    found: hits.length,
    hits: hits.map((bug) => bug.id),
    turns: run.turnsUsed ?? 0,
    tokens: run.tokensUsed ?? 0,
    // Reads and refusals across the parent and every child it sent out.
    //
    // The decomposition that matters: the gathering guard caps a read-only
    // run at 34 calls and its ledger is per-run, so three sub-agents carry
    // four times the read budget of one. If a delegating arm finds more, this
    // says whether it looked harder or looked smarter.
    ...[run, ...children].reduce(
      (totals, entry) => {
        const counted = toolCalls(entry)
        return {
          reads: totals.reads + counted.reads,
          refused: totals.refused + counted.refused
        }
      },
      { reads: 0, refused: 0 }
    ),
    seconds: Math.round((run.activeMs ?? 0) / 1000),
    // Why it ended, condensed — an arm that keeps hitting one guard is a
    // finding about the guard, not about sub-agents.
    ended: /every tool call was refused/i.test(run.lastError ?? '')
      ? 'refused'
      : /turns without finishing/i.test(run.lastError ?? '')
        ? 'turn-cap'
        : /token budget|time budget/i.test(run.lastError ?? '')
          ? 'budget'
          : run.status
  }
})

const ARMS = ['off', 'off-split', 'off-brief', '1', '2', '3']
const groups = ARMS.map((arm) => ({ arm, runs: scored.filter((run) => run.arm === arm) })).filter(
  (group) => group.runs.length > 0
)

const markdown = process.argv.includes('--markdown')
const line = (cells) => (markdown ? `| ${cells.join(' | ')} |` : cells.map(String).join('\t'))

const header = [
  'arm',
  'n',
  'found~',
  'found avg',
  'range',
  'turns',
  'reads',
  'refused',
  'tokens',
  'sec',
  'subAgents'
]
console.log(line(header))
if (markdown) console.log(`|${header.map(() => '---').join('|')}|`)
for (const { arm, runs } of groups) {
  const found = runs.map((run) => run.found)
  console.log(
    line([
      arm,
      runs.length,
      median(found),
      round(mean(found)),
      `${Math.min(...found)}-${Math.max(...found)}`,
      round(mean(runs.map((run) => run.turns))),
      round(mean(runs.map((run) => run.reads))),
      round(mean(runs.map((run) => run.refused))),
      Math.round(mean(runs.map((run) => run.tokens))),
      Math.round(mean(runs.map((run) => run.seconds))),
      round(mean(runs.map((run) => run.subAgents)))
    ])
  )
}

console.log('\nHow each arm ended:')
for (const { arm, runs } of groups) {
  const tally = {}
  for (const run of runs) tally[run.ended] = (tally[run.ended] ?? 0) + 1
  console.log(
    `  ${arm}\t` +
      Object.entries(tally)
        .map(([reason, count]) => `${reason}=${count}`)
        .join(' ')
  )
}

console.log('\nPer-bug hit rate:')
const bugHeader = ['bug', ...groups.map((group) => group.arm)]
console.log(line(bugHeader))
if (markdown) console.log(`|${bugHeader.map(() => '---').join('|')}|`)
for (const bug of ANSWER_KEY) {
  console.log(
    line([
      bug.id,
      ...groups.map((group) => {
        const hit = group.runs.filter((run) => run.hits.includes(bug.id)).length
        return `${hit}/${group.runs.length}`
      })
    ])
  )
}

console.log('\nEvery run:')
for (const run of scored) {
  console.log(
    `  arm=${run.arm.padEnd(3)} ${run.ended.padEnd(8)} found=${String(run.found).padStart(2)}/12` +
      ` turns=${String(run.turns).padStart(2)} reads=${String(run.reads).padStart(3)}` +
      ` refused=${String(run.refused).padStart(2)} tokens=${String(run.tokens).padStart(6)}` +
      ` ${String(run.seconds).padStart(4)}s sub=${run.subAgents}  ${run.runId}`
  )
}
