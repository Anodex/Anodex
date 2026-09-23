// The shared machinery behind the long-horizon build benchmarks.
//
// A benchmark of this shape is always the same five commands — lay out a
// workspace, arm the Scheduler to continue the series, watch and score each
// finished run, print the curve, take the schedule away again — over a
// different spec, rubric and goal. This file is that machinery; each benchmark
// is the configuration it lacks.
//
// The curve is the result. Rising means the agent can be trusted with ongoing
// work; rising then dipping means it broke something it had already built;
// flat means it has stopped making progress at all.
//
// Runs after the first are started by the Scheduler's own continuation rather
// than by this file, because that continuation is as much under test as the
// agent is.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const USER_DATA = path.join(os.homedir(), 'AppData', 'Roaming', 'anodex')
const RUNS = path.join(USER_DATA, 'agent-runs', 'runs.json')
const TASKS = path.join(USER_DATA, 'scheduled-tasks', 'tasks.json')

export const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/**
 * The tools a build benchmark needs, and nothing else.
 *
 * Narrow on purpose: a run that can reach for anything tells you less about
 * what it did with what it had.
 */
export const BUILD_TOOLS = [
  'list_directory',
  'read_file',
  'read_file_range',
  'read_multiple_files',
  'search_files',
  'find_files',
  'write_file',
  'edit_file',
  'run_command'
]

/**
 * The budget a single feature gets.
 *
 * Forty minutes was the first guess and it was too tight: seven of the first
 * eighteen roguelike runs stopped on the clock mid-edit rather than because
 * they had finished or given up, and a run killed mid-edit is the one case
 * that can leave the workspace worse than it found it. Each turn on a 27B at
 * 65k costs three to five minutes, so this is roughly fifteen turns of room.
 */
export const FEATURE_BUDGET = {
  maxTurns: 45,
  maxTokens: 600_000,
  maxDurationMinutes: 75,
  // Pinned, never inherited. The first roguelike attempt ran at 8,192 because
  // its spec said nothing about context, and a 6,694-byte task list does not
  // fit a result budget that small — so the run could not read its own
  // checklist and spent 177 calls working around that.
  contextSize: 65_536,
  parallelJobs: 1
}

/**
 * Every guard that fired on a run, read from its transcript.
 *
 * Refusals carry the guard's own words in `detail` — "Blocked: gathering
 * without progress", "Blocked: repeating call" — so grouping by that names the
 * guard without this file having to know which guards exist.
 *
 * This exists because one was missed. Nine runs stalled, the log showed both
 * "gathering" and "context recoveries", the second was chased and fixed, and
 * the first was still there blocking `finish_goal` on the relaunch. An
 * enumeration would have shown two entries.
 */
export function guardsFor(run) {
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

/**
 * Which features a run had working.
 *
 * Recorded directly since the harness was extracted. Rows written before that
 * only have `failing`, so for those it is worked back out of the feature
 * count — which is possible only while a rubric numbers its features, and
 * those older rows do.
 */
function passingOf(row, total) {
  if (row.passing) return row.passing
  const failing = new Set(row.failing ?? [])
  if ([...failing].some((feature) => typeof feature !== 'number')) return []
  const out = []
  for (let feature = 1; feature <= (row.total ?? total); feature++) {
    if (!failing.has(feature)) out.push(feature)
  }
  return out
}

/**
 * Build the five commands for one benchmark.
 *
 * @param {object} config
 * @param {string} config.taskId        stable id for the Scheduler entry
 * @param {string} config.name          what the Scheduler calls the task
 * @param {string} config.marker        a phrase every run's goal contains
 * @param {string} config.workspace     where the agent works
 * @param {Function} config.writeWorkspace  lays the fixture out
 * @param {string} config.goal          the run's instructions
 * @param {string} config.acceptScript  the hidden rubric
 * @param {string} config.featuresFile  the checklist, for counting ticks
 * @param {string} config.specPath      where run one's spec is written
 * @param {string} config.resultsPath   where the curve is recorded
 * @param {string} config.snapshotsPath where each run's workspace is kept
 * @param {number} config.total         how many checks the rubric has
 * @param {string} [config.inheritedScript] an earlier phase's rubric, re-run every
 *   time to prove this phase has not broken what it builds on
 * @param {object} [config.budget]      overrides for FEATURE_BUDGET
 */
export function benchmark(config) {
  const {
    taskId,
    name,
    marker,
    workspace,
    writeWorkspace,
    goal,
    acceptScript,
    featuresFile,
    specPath,
    resultsPath,
    snapshotsPath,
    total,
    inheritedScript = null,
    budget = {}
  } = config

  function setup() {
    writeWorkspace(workspace)
    fs.writeFileSync(
      specPath,
      JSON.stringify(
        {
          goal,
          project: path.basename(workspace),
          projectPath: workspace,
          enabledTools: BUILD_TOOLS,
          provider: 'local',
          requirePlan: false,
          ...FEATURE_BUDGET,
          ...budget
        },
        null,
        2
      ) + '\n'
    )
    fs.rmSync(resultsPath, { force: true })
    fs.rmSync(snapshotsPath, { recursive: true, force: true })
    console.log(`workspace at ${workspace}`)
    console.log(`run 1 spec at ${specPath}`)
    console.log('\nStart run 1 with:')
    console.log(`  ANODEX_AGENT_AUTORUN=${specPath} npm run dev`)
  }

  /** Every top-level run of this benchmark, oldest first. */
  function benchRuns() {
    return (readJson(RUNS, []) ?? [])
      .filter((run) => !run.parentRunId && run.goal?.includes(marker))
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  /**
   * Schedule the continuation that drives every run after the first.
   *
   * Writes `tasks.json` directly, which the app reads when it starts. A
   * running app keeps its tasks in memory and does not re-read the file, so
   * both `arm` and `cleanup` take effect on the next app start — a `cleanup`
   * against a running app leaves the series continuing, which looked for a
   * while like the Scheduler ignoring a removal. It is not: nothing reads the
   * file again. Stop a live series by restarting the app.
   */
  function arm() {
    const runs = benchRuns()
    if (runs.length === 0) {
      console.error('No run of this benchmark yet — do `setup` and run it first.')
      process.exit(1)
    }
    const series = runs[0].seriesId ?? runs[0].id
    const now = Date.now()
    const tasks = (readJson(TASKS, []) ?? []).filter((task) => task.id !== taskId)
    tasks.push({
      id: taskId,
      name,
      prompt: '',
      projectId: null,
      // Short, because a continuation is skipped while the series is still
      // working. Firing often just means the next feature starts promptly
      // after the last one lands, rather than waiting out a long interval.
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

  function runRubric(script) {
    const output = execFileSync('python', [script, workspace, '--json'], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 15 * 60 * 1000
    })
    // The rubrics print differently: one emits pretty-printed JSON and nothing
    // else, the other a line per feature and then JSON on one line. Both end
    // with an object that opens at the start of a line.
    const start = output.lastIndexOf('\n{')
    return JSON.parse(start >= 0 ? output.slice(start + 1) : output.trim())
  }

  function score() {
    return runRubric(acceptScript)
  }

  /**
   * The rubric for work an earlier phase finished, re-run to prove this phase
   * has not broken it.
   *
   * Phase two's goal tells the agent "everything ticked is checked again after
   * this run, the engine included". Nothing was actually checking the engine —
   * the promise was true of phase one and quietly false of phase two, which is
   * the same kind of unbacked claim this benchmark exists to catch in a model.
   */
  function scoreInherited() {
    if (!inheritedScript) return null
    try {
      const result = runRubric(inheritedScript)
      return { passed: result.passed, total: result.total }
    } catch (error) {
      return { passed: 0, total: 0, error: String(error.message ?? error).slice(0, 200) }
    }
  }

  function ticked() {
    try {
      const text = fs.readFileSync(path.join(workspace, featuresFile), 'utf8')
      return (text.match(/- \[x\]/gi) ?? []).length
    } catch {
      return 0
    }
  }

  async function watch() {
    fs.mkdirSync(snapshotsPath, { recursive: true })
    const seen = new Set((readJson(resultsPath, []) ?? []).map((row) => row.runId))
    console.log('watching. Ctrl-C to stop.')
    for (;;) {
      for (const run of benchRuns()) {
        if (seen.has(run.id)) continue
        if (!['done', 'stopped', 'error'].includes(run.status)) continue
        seen.add(run.id)

        // Snapshot before scoring: the rubric writes nothing, but a run that
        // starts while scoring is in flight would otherwise be graded halfway
        // through its own work. Keyed on the run id, because keying on
        // arm-and-repeat once let a second pass overwrite a first pass's
        // workspace while leaving its row behind — and the report then graded
        // the same code twice and called it two samples.
        const snapshot = path.join(snapshotsPath, run.id)
        fs.rmSync(snapshot, { recursive: true, force: true })
        fs.cpSync(workspace, snapshot, { recursive: true })

        let result
        try {
          result = score()
        } catch (error) {
          result = { passed: 0, total, results: [], error: String(error.message ?? error) }
        }
        const rows = readJson(resultsPath, []) ?? []
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
          inherited: scoreInherited(),
          ticked: ticked(),
          passed: result.passed,
          total: result.total,
          failing: (result.results ?? []).filter((r) => !r.passed).map((r) => r.feature),
          passing: (result.results ?? []).filter((r) => r.passed).map((r) => r.feature),
          at: new Date().toISOString()
        })
        fs.writeFileSync(resultsPath, JSON.stringify(rows, null, 2) + '\n')
        const row = rows[rows.length - 1]
        console.log(
          `run ${rows.length}: ${run.status}, ${run.turnsUsed} turns — ` +
            `${result.passed}/${result.total} features, ${row.ticked} boxes ticked`
        )
        // Every guard, not the first one noticed.
        for (const refusal of row.refusals ?? []) {
          console.log(`    ${refusal.count}x ${refusal.reason} (${refusal.tools.join(', ')})`)
        }
        if (row.inherited) {
          const kept = row.inherited.passed
          const was = row.inherited.total
          console.log(`    engine: ${kept}/${was}${kept < was ? '  <-- BROKE EARLIER WORK' : ''}`)
        }
        if (row.stoppedBecause) console.log(`    ended: ${row.stoppedBecause}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 20_000))
    }
  }

  function report() {
    const rows = readJson(resultsPath, []) ?? []
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
      // A regression is a feature seen working in an earlier run that is not
      // working now. Compared as sets, so a rubric may name its features
      // however it likes.
      const lost = [...everPassed].filter((feature) => failingNow.has(feature)).sort()
      for (const feature of passingOf(row, total)) everPassed.add(feature)
      best = Math.max(best, row.passed)
      console.log(
        `${String(row.index).padStart(4)}  ${(row.status ?? '').padEnd(8)} ` +
          `${String(row.turnsUsed ?? 0).padStart(5)} ` +
          `${String(Math.round((row.activeMs ?? 0) / 60000)).padStart(5)}  ` +
          `${String(row.passed).padStart(7)}  ${String(row.ticked).padStart(7)}  ` +
          `${lost.length ? lost.join(', ') : '—'}`
      )
    }
    const last = rows[rows.length - 1]
    console.log(
      `\n${rows.length} runs, best ${best}/${last.total}, now ${last.passed}/${last.total}`
    )
    if (last.failing?.length) {
      console.log(`still failing: ${last.failing.join('; ')}`)
    }
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

    // Guards, counted across the whole series. Two guards firing is two
    // problems, and reading only one of them is how one got missed.
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

  /** Take the schedule away. Takes effect on the next app start — see `arm`. */
  function cleanup() {
    const tasks = (readJson(TASKS, []) ?? []).filter((task) => task.id !== taskId)
    fs.writeFileSync(TASKS, JSON.stringify(tasks, null, 2) + '\n')
    console.log('schedule removed from tasks.json (restart the app to stop a live series)')
  }

  return { setup, arm, watch, report, cleanup, benchRuns, score, ticked }
}

/** Dispatch argv for a benchmark built with {@link benchmark}. */
export async function main(commands, usage) {
  const command = process.argv[2]
  if (command === 'setup') commands.setup()
  else if (command === 'arm') commands.arm()
  else if (command === 'watch') await commands.watch()
  else if (command === 'report') commands.report()
  else if (command === 'cleanup') commands.cleanup()
  else {
    console.error(usage)
    process.exit(1)
  }
}
