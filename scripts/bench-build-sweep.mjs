// Run the build A/B sweep unattended.
//
// The same shape as `bench-subagents-sweep.mjs` — one app launch per arm,
// because `agentAutorun` fires once at startup — with the two differences a
// *build* benchmark forces:
//
//   1. The workspace is rebuilt from the fixture before every run. The bug
//      hunt was read-only and so needed no reset; a run that writes code
//      leaves the next arm starting from the last arm's answer.
//   2. The finished workspace is archived before the next run wipes it, so it
//      can be graded afterwards rather than in the middle of the sweep.
//
// Usage:
//   node scripts/bench-build-sweep.mjs [--repeats 2] [--arms off-1job,off-3jobs,sub-1,sub-2]
import { spawn, execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { WORKSPACE, writeWorkspace } from './bench-build-fixture.mjs'

const USER_DATA = path.join(os.homedir(), 'AppData', 'Roaming', 'anodex')
const RUNS = path.join(USER_DATA, 'agent-runs', 'runs.json')
const RESULTS = path.join('scripts', 'bench-build-results.json')
const ARCHIVE = path.join('scripts', 'bench-build-runs')
const LOG_DIR = path.join(os.tmpdir(), 'anodex-build-sweep')

const RUN_TIMEOUT_MS = 85 * 60 * 1000
const POLL_MS = 5000

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index > -1 ? process.argv[index + 1] : fallback
}

const repeats = Number(arg('repeats', '2'))
const arms = arg('arms', 'off-1job,off-3jobs,sub-1,sub-2').split(',')

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const isTerminal = (s) => s === 'done' || s === 'stopped' || s === 'error'
const existingRunIds = () => new Set((readJson(RUNS, []) ?? []).map((run) => run.id))

/** See the note in the sibling sweep: `/T`, or llama-server keeps the GPU. */
function killTree(child) {
  if (!child.pid) return
  try {
    execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore' })
  } catch {
    // Already gone.
  }
}

async function runArm(arm, repeat) {
  const spec = path.join('scripts', `bench-build-${arm}.json`)
  if (!fs.existsSync(spec)) throw new Error(`No spec for arm "${arm}" at ${spec}`)
  fs.mkdirSync(LOG_DIR, { recursive: true })
  const logPath = path.join(LOG_DIR, `arm-${arm}-${repeat}.log`)

  // Every arm starts from the same empty workspace. Nothing here is clever,
  // and that is the point: a reset that can be skipped is a reset that
  // eventually is, and the arm that inherits the previous arm's code scores
  // like a triumph.
  writeWorkspace(WORKSPACE)

  const log = fs.openSync(logPath, 'w')
  const before = existingRunIds()
  console.log(`\n=== ${arm} #${repeat} — starting (${logPath})`)
  const child = spawn('npm', ['run', 'dev'], {
    env: { ...process.env, ANODEX_AGENT_AUTORUN: spec },
    stdio: ['ignore', log, log],
    shell: true
  })

  const deadline = Date.now() + RUN_TIMEOUT_MS
  let result = null
  try {
    while (Date.now() < deadline) {
      await sleep(POLL_MS)
      const runs = readJson(RUNS, []) ?? []
      const started = runs.find((run) => !before.has(run.id) && !run.parentRunId)
      if (started && isTerminal(started.status)) {
        result = started
        break
      }
    }
  } finally {
    killTree(child)
    fs.closeSync(log)
    await sleep(8000)
  }

  // Archived whether or not the run finished cleanly: a timed-out arm that
  // wrote three of four modules is a result, and deleting it would make the
  // sweep look tidier than it was.
  const saved = path.join(ARCHIVE, `${arm}-${repeat}`)
  fs.rmSync(saved, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(saved), { recursive: true })
  fs.cpSync(WORKSPACE, saved, { recursive: true })

  if (!result) {
    console.log(`=== ${arm} #${repeat} — TIMED OUT after ${RUN_TIMEOUT_MS / 60000}m`)
    return { arm, repeat, timedOut: true, logPath, workspace: saved }
  }

  const children = (readJson(RUNS, []) ?? []).filter((run) => run.parentRunId === result.id)
  console.log(
    `=== ${arm} #${repeat} — ${result.status}, ${result.turnsUsed} turns, ` +
      `${result.tokensUsed} tokens, ${children.length} sub-agent(s)`
  )
  return {
    arm,
    repeat,
    runId: result.id,
    status: result.status,
    turnsUsed: result.turnsUsed,
    tokensUsed: result.tokensUsed,
    activeMs: result.activeMs,
    flaggedTurns: result.flaggedTurns,
    subAgents: children.length,
    logPath,
    workspace: saved
  }
}

const results = readJson(RESULTS, []) ?? []
for (let repeat = 1; repeat <= repeats; repeat++) {
  for (const arm of arms) {
    const outcome = await runArm(arm, repeat)
    results.push({ ...outcome, at: new Date().toISOString() })
    fs.writeFileSync(RESULTS, JSON.stringify(results, null, 2) + '\n')
  }
}
console.log(`\nSweep finished. ${results.length} runs recorded in ${RESULTS}`)
console.log('Score them with: node scripts/bench-build-report.mjs')
