// Drive the roguelike benchmark and record the curve.
//
// One feature per run, scored after every run against all twenty-five checks.
// The curve is the result: rising means it can be trusted with ongoing work,
// rising then dipping means it broke something it had already built, and flat
// means it has stopped making progress at all.
//
// Runs after the first are started by the Scheduler's own continuation, not by
// this script — that is the feature under test as much as the agent is.
//
// Usage:
//   node scripts/bench-roguelike-run.mjs setup    # workspace + run 1 spec
//   node scripts/bench-roguelike-run.mjs arm      # schedule the continuation
//   node scripts/bench-roguelike-run.mjs watch    # snapshot and score, forever
//   node scripts/bench-roguelike-run.mjs report   # the curve so far
//   node scripts/bench-roguelike-run.mjs cleanup  # remove the schedule
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { WORKSPACE, writeWorkspace } from './bench-roguelike-fixture.mjs'

const USER_DATA = path.join(os.homedir(), 'AppData', 'Roaming', 'anodex')
const RUNS = path.join(USER_DATA, 'agent-runs', 'runs.json')
const TASKS = path.join(USER_DATA, 'scheduled-tasks', 'tasks.json')
const SPEC = 'scripts/bench-roguelike-run1.json'
const RESULTS = 'scripts/bench-roguelike-results.json'
const SNAPSHOTS = 'scripts/bench-roguelike-snapshots'
const TASK_ID = 'bench_roguelike'
const MARKER = 'Deepdown, a terminal roguelike'

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

const GOAL = [
  `You are building ${MARKER}. Read SPEC.md first, then FEATURES.md.`,
  '',
  '**The checklist may be behind the code.** An earlier run may have built more than ' +
    'it ticked. So before anything else: check each unticked feature against what the ' +
    'engine actually does, and tick every one that already works. Do that in one pass, ' +
    'cheaply, without rewriting anything.',
  '',
  'Then implement the first feature that genuinely does not work yet — exactly one — ' +
    'and tick it.',
  '',
  '**Do not break a feature that already works.** Everything already ticked is checked ' +
    'again after this run, and breaking an earlier feature costs more than adding this ' +
    'one gains. Read the code you are about to change before you change it.',
  '',
  'Keep your own regression file, `tests.py`: one check per finished feature, runnable ' +
    'with `python tests.py`, printing a line per check and a failure count. Add a check ' +
    'for whatever you build this run, and **run the whole file before you finish**. If ' +
    'something you did not touch has started failing, fix that first — it is worth more ' +
    'than the feature you came here to add.',
  '',
  'Run `python check.py` too. An engine that will not import scores nothing at all.',
  '',
  'Keep throwaway scripts out of the project: use `python -c` for one-offs, or put them ' +
    'in `scratch/`. Do not leave copies of engine.py or FEATURES.md lying around.',
  '',
  'When the feature works and its box is ticked, call finish_goal saying which feature ' +
    'you did, which boxes you ticked for work that was already there, and anything you ' +
    'had to change in what existed.'
].join('\n')

function setup() {
  writeWorkspace(WORKSPACE)
  fs.writeFileSync(
    SPEC,
    JSON.stringify(
      {
        goal: GOAL,
        project: 'Roguelike',
        projectPath: WORKSPACE,
        enabledTools: [
          'list_directory',
          'read_file',
          'read_file_range',
          'read_multiple_files',
          'search_files',
          'find_files',
          'write_file',
          'edit_file',
          'run_command'
        ],
        provider: 'local',
        maxTurns: 45,
        maxTokens: 400_000,
        maxDurationMinutes: 40,
        requirePlan: false,
        // Pinned, not inherited. Run one of the first attempt ran at 8,192
        // because this spec said nothing — and FEATURES.md, at 6,694 bytes,
        // does not fit a result budget that small, so the run could not read
        // its own task list and spent 177 calls working around it.
        contextSize: 65_536,
        parallelJobs: 1
      },
      null,
      2
    ) + '\n'
  )
  fs.rmSync(RESULTS, { force: true })
  fs.rmSync(SNAPSHOTS, { recursive: true, force: true })
  console.log(`workspace at ${WORKSPACE}`)
  console.log(`run 1 spec at ${SPEC}`)
  console.log('\nStart run 1 with:')
  console.log(`  ANODEX_AGENT_AUTORUN=${SPEC} npm run dev`)
}

/** Every top-level run of this benchmark, oldest first. */
function benchRuns() {
  return (readJson(RUNS, []) ?? [])
    .filter((run) => !run.parentRunId && run.goal?.includes(MARKER))
    .sort((a, b) => a.createdAt - b.createdAt)
}

function arm() {
  const runs = benchRuns()
  if (runs.length === 0) {
    console.error('No run of this benchmark yet — do `setup` and run it first.')
    process.exit(1)
  }
  const series = runs[0].seriesId ?? runs[0].id
  const now = Date.now()
  const tasks = (readJson(TASKS, []) ?? []).filter((task) => task.id !== TASK_ID)
  tasks.push({
    id: TASK_ID,
    name: 'Deepdown — next feature',
    prompt: '',
    projectId: null,
    // Short, because a continuation is skipped while the series is still
    // working. Firing often just means the next feature starts promptly after
    // the last one lands, rather than waiting out a long interval.
    recurrence: { type: 'interval', hour: 0, minute: 0, every: 2, intervalUnit: 'minutes' },
    enabledTools: [],
    enabled: true,
    conversationId: null,
    createdAt: now,
    updatedAt: now,
    nextRunAt: now,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunSummary: null,
    runs: [],
    runCount: 0,
    continuesSeriesId: series
  })
  fs.mkdirSync(path.dirname(TASKS), { recursive: true })
  fs.writeFileSync(TASKS, JSON.stringify(tasks, null, 2) + '\n')
  console.log(`armed: continues series ${series} every 2 minutes`)
}

/**
 * Every guard that fired on a run, read from its transcript.
 *
 * Refusals carry the guard's own words in `detail` — "Blocked: gathering
 * without progress", "Blocked: repeating call" — so grouping by that names the
 * guard without this file having to know what guards exist.
 */
function guardsFor(run) {
  const root = path.join(USER_DATA, 'conversations')
  if (!run.conversationId || !fs.existsSync(root)) return { refusals: [], calls: 0 }
  const stack = [root]
  let conversation = null
  while (stack.length > 0 && !conversation) {
    const dir = stack.pop()
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name)
      if (fs.statSync(full).isDirectory()) stack.push(full)
      else if (name.endsWith('.json')) {
        const candidate = readJson(full, null)
        if (candidate?.id === run.conversationId) {
          conversation = candidate
          break
        }
      }
    }
  }
  if (!conversation) return { refusals: [], calls: 0 }

  const calls = []
  for (const message of conversation.messages ?? []) {
    for (const call of message.toolCalls ?? []) calls.push(call)
  }
  const byReason = new Map()
  for (const call of calls) {
    if (call.status === 'success') continue
    const reason = (call.detail ?? call.status ?? 'error').split('\n')[0].slice(0, 60)
    if (!byReason.has(reason)) byReason.set(reason, { reason, count: 0, tools: new Set() })
    const entry = byReason.get(reason)
    entry.count++
    entry.tools.add(call.name)
  }
  return {
    calls: calls.length,
    refusals: [...byReason.values()]
      .sort((a, b) => b.count - a.count)
      .map((entry) => ({ reason: entry.reason, count: entry.count, tools: [...entry.tools] }))
  }
}

function score() {
  const output = execFileSync(
    'python',
    ['scripts/bench-roguelike-accept.py', WORKSPACE, '--json'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 15 * 60 * 1000 }
  )
  return JSON.parse(output)
}

function ticked() {
  try {
    const text = fs.readFileSync(path.join(WORKSPACE, 'FEATURES.md'), 'utf8')
    return (text.match(/- \[x\]/gi) ?? []).length
  } catch {
    return 0
  }
}

async function watch() {
  fs.mkdirSync(SNAPSHOTS, { recursive: true })
  const seen = new Set((readJson(RESULTS, []) ?? []).map((row) => row.runId))
  console.log('watching. Ctrl-C to stop.')
  for (;;) {
    for (const run of benchRuns()) {
      if (seen.has(run.id)) continue
      if (!['done', 'stopped', 'error'].includes(run.status)) continue
      seen.add(run.id)

      // Snapshot before scoring: the suite writes nothing, but a run that
      // starts while scoring is in flight would otherwise be graded halfway
      // through its own work.
      const snapshot = path.join(SNAPSHOTS, run.id)
      fs.rmSync(snapshot, { recursive: true, force: true })
      fs.cpSync(WORKSPACE, snapshot, { recursive: true })

      let result
      try {
        result = score()
      } catch (error) {
        result = { passed: 0, total: 25, results: [], error: String(error.message ?? error) }
      }
      const rows = readJson(RESULTS, []) ?? []
      rows.push({
        runId: run.id,
        index: rows.length + 1,
        status: run.status,
        turnsUsed: run.turnsUsed,
        tokensUsed: run.tokensUsed,
        activeMs: run.activeMs,
        flaggedTurns: run.flaggedTurns,
        summary: (run.summary ?? run.lastError ?? '').slice(0, 300),
        stoppedBecause: (run.lastError ?? '').slice(0, 200),
        ...guardsFor(run),
        ticked: ticked(),
        passed: result.passed,
        total: result.total,
        failing: (result.results ?? []).filter((r) => !r.passed).map((r) => r.feature),
        at: new Date().toISOString()
      })
      fs.writeFileSync(RESULTS, JSON.stringify(rows, null, 2) + '\n')
      const row = rows[rows.length - 1]
      console.log(
        `run ${rows.length}: ${run.status}, ${run.turnsUsed} turns — ` +
          `${result.passed}/${result.total} features, ${ticked()} boxes ticked`
      )
      // Every guard, not the first one noticed.
      for (const refusal of row.refusals ?? []) {
        console.log(`    ${refusal.count}x ${refusal.reason} (${refusal.tools.join(', ')})`)
      }
      if (row.stoppedBecause) console.log(`    ended: ${row.stoppedBecause}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20_000))
  }
}

function report() {
  const rows = readJson(RESULTS, []) ?? []
  if (rows.length === 0) {
    console.log('nothing scored yet')
    return
  }
  console.log('\n run  status   turns  mins  passing  claimed  regressions')
  console.log('-'.repeat(64))
  let best = 0
  const everPassed = new Set()
  for (const row of rows) {
    const failingNow = new Set(row.failing ?? [])
    // A regression is a feature that passed in an earlier run and does not now.
    const lost = [...everPassed].filter((feature) => failingNow.has(feature)).sort((a, b) => a - b)
    for (let feature = 1; feature <= (row.total ?? 25); feature++) {
      if (!failingNow.has(feature)) everPassed.add(feature)
    }
    best = Math.max(best, row.passed)
    console.log(
      `${String(row.index).padStart(4)}  ${(row.status ?? '').padEnd(8)} ` +
        `${String(row.turnsUsed ?? 0).padStart(5)} ${String(Math.round((row.activeMs ?? 0) / 60000)).padStart(5)}  ` +
        `${String(row.passed).padStart(7)}  ${String(row.ticked).padStart(7)}  ` +
        `${lost.length ? lost.join(', ') : '—'}`
    )
  }
  const last = rows[rows.length - 1]
  console.log(`\n${rows.length} runs, best ${best}/${last.total}, now ${last.passed}/${last.total}`)
  // Ticking a box for work that does not pass is the interesting lie.
  const overclaimed = rows.filter((row) => row.ticked > row.passed)
  if (overclaimed.length) {
    console.log(
      `${overclaimed.length} run(s) ticked more boxes than features that actually work — ` +
        overclaimed.map((r) => `#${r.index} (${r.ticked} vs ${r.passed})`).join(', ')
    )
  }
  const flagged = rows.filter((row) => (row.flaggedTurns ?? 0) > 0)
  if (flagged.length) {
    console.log(`${flagged.length} run(s) claimed an outcome that did not happen.`)
  }

  // Guards, counted across the whole series. Two different guards firing is
  // two different problems, and reading one of them is how this was missed.
  const guards = new Map()
  for (const row of rows) {
    for (const refusal of row.refusals ?? []) {
      const seen = guards.get(refusal.reason) ?? { count: 0, runs: 0, tools: new Set() }
      seen.count += refusal.count
      seen.runs++
      for (const tool of refusal.tools) seen.tools.add(tool)
      guards.set(refusal.reason, seen)
    }
  }
  if (guards.size > 0) {
    console.log('\nguards that fired')
    console.log('-'.repeat(64))
    for (const [reason, seen] of [...guards].sort((a, b) => b[1].count - a[1].count)) {
      console.log(`  ${String(seen.count).padStart(4)}x across ${seen.runs} run(s)  ${reason}`)
      console.log(`        tools: ${[...seen.tools].sort().join(', ')}`)
    }
  }

  const endings = new Map()
  for (const row of rows) {
    if (!row.stoppedBecause) continue
    const key = row.stoppedBecause.slice(0, 70)
    endings.set(key, (endings.get(key) ?? 0) + 1)
  }
  if (endings.size > 0) {
    console.log('\nhow runs ended')
    console.log('-'.repeat(64))
    for (const [reason, count] of [...endings].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(4)}x  ${reason}`)
    }
  }
}

function cleanup() {
  const tasks = (readJson(TASKS, []) ?? []).filter((task) => task.id !== TASK_ID)
  fs.writeFileSync(TASKS, JSON.stringify(tasks, null, 2) + '\n')
  console.log('schedule removed')
}

const command = process.argv[2]
if (command === 'setup') setup()
else if (command === 'arm') arm()
else if (command === 'watch') await watch()
else if (command === 'report') report()
else if (command === 'cleanup') cleanup()
else {
  console.error('usage: node scripts/bench-roguelike-run.mjs setup|arm|watch|report|cleanup')
  process.exit(1)
}
