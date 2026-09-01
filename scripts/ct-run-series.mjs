// Run a series of Critical Thinking questions unattended, one per app restart.
//
// The main process is bundled at dev-server start and never reloads, and the
// autorun harness arms once at startup, so each question needs its own clean
// launch. Doing that by hand is the slowest step in the measure-fix-remeasure
// loop; this does the kill, the launch, and the wait, and records the outcome.
//
// Usage: node scripts/ct-run-series.mjs <question-file> [<question-file> ...]
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const RUNS = path.join(process.env.APPDATA, 'anodex', 'critical-thinking', 'runs.json')
const RUNNING = new Set([
  'running',
  'planning',
  'needs-review',
  'researching',
  'synthesizing',
  'validating',
  'repairing',
  'writing'
])

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const stamp = () => new Date().toISOString().slice(11, 19)

function newestRun() {
  try {
    return Object.values(JSON.parse(fs.readFileSync(RUNS, 'utf8'))).sort(
      (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)
    )[0]
  } catch {
    return null
  }
}

function powershell(command) {
  return execFileSync('powershell.exe', ['-NoProfile', '-Command', command], {
    encoding: 'utf8'
  }).trim()
}

/** Kill Electron and llama-server explicitly and verify zero -- killing the npm
 *  wrapper alone detaches them, and a stale instance shares the data directory
 *  with the one being watched. */
function killApp() {
  powershell(
    `Get-CimInstance Win32_Process -Filter "Name='cmd.exe' OR Name='node.exe'" | ` +
      `Where-Object { $_.CommandLine -match 'electron-vite|npm run dev' } | ` +
      `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; ` +
      `Stop-Process -Name electron -Force -ErrorAction SilentlyContinue; ` +
      `Stop-Process -Name llama-server -Force -ErrorAction SilentlyContinue; ` +
      `Start-Sleep -Seconds 5`
  )
  const left = powershell(
    `@(Get-Process electron,llama-server -ErrorAction SilentlyContinue).Count`
  )
  if (left !== '0') throw new Error(`Processes still running after kill: ${left}`)
}

/**
 * Launch through PowerShell's `Start-Process` rather than `spawn('cmd.exe')`.
 *
 * Spawning cmd with a redirect in the argument string exits 1 immediately and
 * writes nothing -- Node's Windows argument quoting and cmd's own parsing do
 * not agree about the `>` -- and it fails silently, which cost a three-hour
 * wait on a run that had never started. The question goes in through a file
 * rather than the command line so no amount of punctuation in it can break the
 * command.
 */
function launch(question, logFile) {
  const questionFile = path.join(process.env.TEMP ?? '.', 'anodex-ct-autorun.txt')
  fs.writeFileSync(questionFile, question, 'utf8')
  powershell(
    `$env:ANODEX_CT_AUTORUN = (Get-Content -Raw '${questionFile}').Trim(); ` +
      `Start-Process -FilePath 'cmd.exe' ` +
      `-ArgumentList '/c npm run dev > "${logFile}" 2>&1' -WindowStyle Hidden`
  )
}

/**
 * Whether Anodex is actually running, rather than merely recorded as running.
 *
 * A run record says `researching` until the app writes a terminal status, so a
 * force-quit leaves one that never settles. Anodex reconciles those itself on
 * its next start (`reconcileInterruptedCriticalThinkingRuns`) - which is
 * precisely the deadlock: this waited for the record to settle before launching
 * the app, and only the app can settle it. Measured: a killed sweep left a
 * `researching` record and the next sweep waited on it indefinitely.
 *
 * Same reasoning `scripts/bench-reset.mjs` applies, for the same reason.
 */
function anodexIsRunning() {
  try {
    return /electron\.exe/i.test(
      execFileSync('tasklist', ['/FI', 'IMAGENAME eq electron.exe', '/NH'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      })
    )
  } catch {
    // No tasklist, or it failed: trust the record, because waiting needlessly
    // is far better than starting a second run over a live one.
    return true
  }
}

async function waitForIdle() {
  for (;;) {
    const run = newestRun()
    if (!run || !RUNNING.has(run.status)) return
    if (!anodexIsRunning()) {
      console.log(stamp(), 'ignoring a stale', run.status, 'record - Anodex is not running')
      return
    }
    console.log(stamp(), 'waiting for the in-flight run to finish:', run.status)
    await sleep(60_000)
  }
}

/** A model load plus planning; generous, but far short of a whole run. */
const START_TIMEOUT_MS = 12 * 60 * 1000

async function waitForStart(after) {
  const deadline = Date.now() + START_TIMEOUT_MS
  for (;;) {
    const run = newestRun()
    if (run && (run.createdAt ?? 0) > after) return
    if (Date.now() > deadline) {
      throw new Error(
        `No run appeared within ${START_TIMEOUT_MS / 60000} minutes -- the app did not start, ` +
          'or the autorun harness never armed. Check the dev log.'
      )
    }
    await sleep(15_000)
  }
}

async function waitForRun(after, timeoutMs = 3 * 60 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs
  let last = ''
  for (;;) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the run.')
    const run = newestRun()
    if (run && (run.createdAt ?? 0) > after) {
      if (run.status !== last) {
        const done = (run.steps ?? []).filter((s) => s.status === 'completed').length
        console.log(
          stamp(),
          ' ',
          run.status,
          `steps ${done}/${(run.steps ?? []).length}`,
          `sources ${(run.sources ?? []).length}`
        )
        last = run.status
      }
      if (!RUNNING.has(run.status)) return run
    }
    await sleep(30_000)
  }
}

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('Usage: node scripts/ct-run-series.mjs <question-file> [...]')
  process.exit(1)
}

await waitForIdle()

for (const file of files) {
  const question = fs.readFileSync(file, 'utf8').trim()
  const name = path.basename(file, '.txt')
  console.log(`\n${stamp()} ===== ${name} =====`)
  try {
    killApp()
    const after = Date.now()
    launch(question, path.resolve(`../ct-dev-${name}.log`))
    // Verify the run actually started by reading the store, rather than trusting
    // that the launch worked. Without this the series waits out its whole
    // timeout on a run that does not exist -- measured, at a cost of three hours.
    await waitForStart(after)
    const run = await waitForRun(after)
    const d = run.synthesisDiagnostics ?? {}
    const steps = run.steps ?? []
    const done = steps.filter((s) => s.status === 'completed').length
    let rounds = 0
    let sufficient = 0
    for (const step of steps)
      for (const round of step.rounds ?? []) {
        const v = round.assessment?.verdict
        if (!v) continue
        rounds++
        if (v === 'sufficient') sufficient++
      }
    console.log(
      `${stamp()} RESULT ${name}: status=${run.status} stage=${d.selectedStage} ` +
        `steps=${done}/${steps.length} chars=${(run.report ?? '').length} ` +
        `suff=${rounds ? Math.round((sufficient / rounds) * 100) : 0}% ` +
        `blockers=[${(d.completion?.blockers ?? []).join(',')}]`
    )
  } catch (error) {
    // Report and carry on: one bad launch should not cost the questions after it.
    console.log(`${stamp()} FAILED ${name}: ${error instanceof Error ? error.message : error}`)
  }
}
console.log(`\n${stamp()} SERIES COMPLETE`)
