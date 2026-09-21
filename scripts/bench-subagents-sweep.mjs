// Run the sub-agent A/B sweep unattended.
//
// Each arm needs its own app launch, because `agentAutorun` fires once at
// startup. So this spawns the dev app with one spec, waits for that run to
// reach a terminal state, kills the app, and moves to the next — which is the
// only way twelve runs happen without somebody sitting here for an afternoon.
//
// Usage:
//   node scripts/bench-subagents-sweep.mjs [--repeats 3] [--arms off,1,2,3]
//
// Results are appended to scripts/bench-subagents-results.json as they land,
// not written at the end: a sweep that dies on run nine should not take the
// first eight with it.
import { spawn, execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const USER_DATA = path.join(os.homedir(), 'AppData', 'Roaming', 'anodex')
const RUNS = path.join(USER_DATA, 'agent-runs', 'runs.json')
const RESULTS = path.join('scripts', 'bench-subagents-results.json')
const LOG_DIR = path.join(os.tmpdir(), 'anodex-subagent-sweep')

/** A run gets this long to finish before the arm is abandoned as hung. */
const RUN_TIMEOUT_MS = 55 * 60 * 1000
const POLL_MS = 5000

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index > -1 ? process.argv[index + 1] : fallback
}

const repeats = Number(arg('repeats', '3'))
const arms = arg('arms', 'off,1,2,3').split(',')

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Run ids that already existed, so a new one is unmistakable. */
function existingRunIds() {
  return new Set((readJson(RUNS, []) ?? []).map((run) => run.id))
}

function isTerminal(status) {
  return status === 'done' || status === 'stopped' || status === 'error'
}

/**
 * Kill the dev app and everything it started.
 *
 * `/T` matters: `npm run dev` is a tree — npm, electron-vite, the Electron
 * main process and llama-server under it. Killing only the parent leaves
 * llama-server holding the GPU, and the next arm then waits forever for a
 * model it cannot load.
 */
function killTree(child) {
  if (!child.pid) return
  try {
    execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore' })
  } catch {
    // Already gone.
  }
}

async function runArm(arm, repeat) {
  const spec = path.join('scripts', `bench-subagents-${arm}.json`)
  if (!fs.existsSync(spec)) throw new Error(`No spec for arm "${arm}" at ${spec}`)
  fs.mkdirSync(LOG_DIR, { recursive: true })
  const logPath = path.join(LOG_DIR, `arm-${arm}-${repeat}.log`)
  const log = fs.openSync(logPath, 'w')

  const before = existingRunIds()
  console.log(`\n=== arm ${arm}, repeat ${repeat} — starting (${logPath})`)
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
      // The parent is the new run without a parent of its own; its children
      // appear underneath it and must not be mistaken for the arm's result.
      const started = runs.find((run) => !before.has(run.id) && !run.parentRunId)
      if (started && isTerminal(started.status)) {
        result = started
        break
      }
    }
  } finally {
    killTree(child)
    fs.closeSync(log)
    // llama-server can take a moment to release the GPU.
    await sleep(8000)
  }

  if (!result) {
    console.log(`=== arm ${arm}, repeat ${repeat} — TIMED OUT after ${RUN_TIMEOUT_MS / 60000}m`)
    return { arm, repeat, timedOut: true, logPath }
  }
  console.log(
    `=== arm ${arm}, repeat ${repeat} — ${result.status}, ` +
      `${result.turnsUsed} turns, ${result.tokensUsed} tokens`
  )
  return { arm, repeat, runId: result.id, logPath }
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
console.log('Score them with: node scripts/bench-subagents-score.mjs --all')
