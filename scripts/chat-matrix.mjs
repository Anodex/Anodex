#!/usr/bin/env node
/**
 * Run the chat conversation script across several models and windows, and
 * score each run with `chat-criteria.mjs`.
 *
 * Usage: node scripts/chat-matrix.mjs <outDir> [modelKey ...]
 *
 * Chat had been judged by me reading a handful of replies from one model at one
 * window size and forming an impression. That is not a measurement: the
 * impression drifts between runs, and an agent matrix on this same machine
 * produced 28/28 from a 27B and 0/28 from a 27B of a different family. Nothing
 * about chat makes it immune to that spread.
 *
 * The runner owns every app instance it starts and kills each one by process
 * tree before the next. That matters for two reasons: Anodex holds an Electron
 * single-instance lock, so a survivor makes the next launch quit silently
 * (see AGENTS.md); and settings are written between runs, which an app still
 * holding a cached copy would clobber on its next save — the exact accident
 * that made an entire session's runs execute at a window I did not intend.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const MODELS_DIR = join(process.env.APPDATA ?? join(homedir(), 'AppData/Roaming'), 'anodex/models')
const SETTINGS = join(
  process.env.APPDATA ?? join(homedir(), 'AppData/Roaming'),
  'anodex/settings.json'
)
/**
 * The conversation to run, and the grader to score it with.
 *
 * Overridable with --script and --criteria so this runner can measure a
 * different surface. Email needs its own script and its own criteria, and
 * copying this file to change two constants is how two runners start drifting
 * apart on everything else — the process handling, the settings write, the
 * kill-before-launch discipline.
 */
const flagValue = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}
const SCRIPT = join(process.cwd(), flagValue('--script', 'scripts/chat-script-matrix.json'))
/**
 * How many prompts this run should get through, read from the script itself.
 *
 * The totals in the report used to be the literal 10 of the original script,
 * which was invisible while there was one script and became wrong the moment
 * there were two: a twelve-prompt run reported "turns 12/10, score 11/10".
 * Scores come from the grader's own `total` for the same reason.
 */
const promptCount = JSON.parse(readFileSync(SCRIPT, 'utf-8')).prompts.length
const CRITERIA = flagValue('--criteria', 'scripts/chat-criteria.mjs')

/**
 * The matrix. Spread over size and family, not just size: the agent matrix's
 * worst result came from a 27B, so "big enough" is not the only axis.
 *
 * The 4K row is deliberate — it is the tightest window anyone actually runs,
 * and the compact prompt is selected below 24K, so most of these rows exercise
 * the prompt the majority of local users get. The final row is the only one
 * that reaches the full prompt, which is otherwise untested.
 */
const MATRIX = [
  { key: 'dscoder16b', file: 'DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M.gguf', ctx: 8192 },
  { key: 'qwen4b', file: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf', ctx: 8192 },
  { key: 'peach9b', file: 'Peach-9B-8k-Roleplay-Q4_K_M.gguf', ctx: 8192 },
  { key: 'mythomax13b', file: 'mythomax-l2-kimiko-v2-13b.Q4_K_M.gguf', ctx: 4096 },
  { key: 'devstral24b', file: 'Devstral-Small-2507-Q4_K_M.gguf', ctx: 8192 },
  { key: 'qwen27b', file: 'Qwen3.8-27B-UD-Q4_K_M.gguf', ctx: 8192 },
  { key: 'gemma27b', file: 'gemma-3-27b-it-Q4_K_M.gguf', ctx: 8192 },
  { key: 'qwen27b-full', file: 'Qwen3.8-27B-UD-Q4_K_M.gguf', ctx: 65536 },
  // The vision transport at the tightest window. Every other row above 4K runs
  // comfortably, and mythomax13b covers 4K only on the node-llama-cpp path —
  // this is the same stress on `LlamaVisionService`, which sizes its tool
  // surface by its own rule and measures schema JSON without the system prompt.
  { key: 'qwen27b-4k', file: 'Qwen3.8-27B-UD-Q4_K_M.gguf', ctx: 4096 }
]

// Flags and their values are stripped, so what remains is the out directory
// followed by optional model keys.
const positional = process.argv.slice(2).filter((arg, index, all) => {
  if (arg.startsWith('--')) return false
  const previous = all[index - 1]
  return previous !== '--script' && previous !== '--criteria'
})
const [outDir, ...only] = positional
if (!outDir) {
  console.error('Usage: node scripts/chat-matrix.mjs <outDir> [modelKey ...]')
  process.exit(2)
}
mkdirSync(outDir, { recursive: true })

/** Generous: a 27B at 65K can spend minutes loading before the first token. */
const RUN_TIMEOUT_MS = 30 * 60 * 1000
const POLL_MS = 5000

const rows = []
const selected = MATRIX.filter((entry) => only.length === 0 || only.includes(entry.key))

for (const entry of selected) {
  const modelPath = join(MODELS_DIR, entry.file)
  if (!existsSync(modelPath)) {
    console.log(`SKIP ${entry.key}: no such model file`)
    rows.push({ ...entry, skipped: 'model file missing' })
    continue
  }

  applySettings(modelPath, entry.ctx)
  const logPath = join(outDir, `${entry.key}.log`)
  console.log(`\n=== ${entry.key} @ ${entry.ctx} ===`)

  const started = Date.now()
  const finished = await runOnce(logPath)
  const seconds = Math.round((Date.now() - started) / 1000)

  const graded = grade(logPath)
  rows.push({ ...entry, seconds, finished, ...graded })
  if (graded.launchFailure) {
    // Not a score. Printing one here is how a dead harness gets mistaken for a
    // regression.
    console.log(`${entry.key}: HARNESS FAILURE - ${graded.launchFailure}  (${seconds}s)`)
  } else {
    console.log(
      `${entry.key}: ${graded.score}/${graded.total}  turns ${graded.turns}/${promptCount}  ${seconds}s${finished ? '' : '  (TIMED OUT)'}`
    )
  }
  for (const result of graded.results.filter((item) => !item.passed)) {
    console.log(`    FAIL ${result.id}`)
  }
}

writeFileSync(join(outDir, 'summary.json'), JSON.stringify(rows, null, 2))
console.log(`\n${renderTable(rows)}`)
console.log(`\nwrote ${join(outDir, 'summary.json')}`)

/**
 * Point settings at one model and window.
 *
 * Written directly rather than through the app because the app is not running
 * at this moment — which is the only safe time to do it. `SettingsStore` keeps
 * an in-memory cache and rewrites the whole file on its next save, so editing
 * this file under a live instance silently loses the edit.
 */
function applySettings(modelPath, contextSize) {
  const settings = JSON.parse(readFileSync(SETTINGS, 'utf-8'))
  settings.lastModelPath = modelPath
  settings.modelContextSizes = { ...settings.modelContextSizes, [modelPath]: contextSize }
  writeFileSync(SETTINGS, JSON.stringify(settings, null, 2))
}

/** Start the app with the harness armed, wait for its completion line, kill it. */
function runOnce(logPath) {
  return new Promise((resolve) => {
    const log = createWriteStream(logPath, { flags: 'w' })
    const child = spawn('npm', ['run', 'dev'], {
      env: { ...process.env, ANODEX_CHAT_AUTORUN: SCRIPT },
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout.pipe(log)
    child.stderr.pipe(log)

    const deadline = Date.now() + RUN_TIMEOUT_MS
    /**
     * A launch that never produces a turn is dead long before the timeout.
     *
     * Loading a 27B at 65K can take minutes, so this is generous — but a run
     * that has written nothing after eight has not started, and waiting the
     * remaining twenty-two proves nothing. That happened tonight: a leftover
     * dev server held the port, Electron quit on the single-instance lock, and
     * the run sat silent while a real measurement waited behind it.
     */
    const firstTurnDeadline = Date.now() + 8 * 60 * 1000
    const timer = setInterval(() => {
      let text = ''
      try {
        text = readFileSync(logPath, 'utf-8')
      } catch {
        text = ''
      }
      const done = /CHAT AUTORUN COMPLETE|Autorun failed/.test(text)
      const neverStarted = Date.now() > firstTurnDeadline && !/TURN \d+\/\d+/.test(text)
      if (neverStarted) {
        clearInterval(timer)
        killTree(child.pid)
        setTimeout(() => resolve(false), 2000)
        return
      }
      if (done || Date.now() > deadline) {
        clearInterval(timer)
        killTree(child.pid)
        // Give Windows a moment to release the single-instance lock before the
        // next iteration launches into it.
        spawnSync(process.execPath, ['-e', 'setTimeout(()=>{}, 4000)'])
        resolve(done)
      }
    }, POLL_MS)
  })
}

/**
 * Kill the whole process tree.
 *
 * `npm run dev` is npm, which spawns electron-vite, which spawns Electron and
 * its helpers. Killing only the pid we hold leaves Electron running, holding
 * the single-instance lock, which is the failure this whole function exists to
 * avoid. `taskkill /T` is used rather than PowerShell because it is a plain
 * executable and works from a sandboxed shell where a PowerShell hop does not.
 */
function killTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' })
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

function grade(logPath) {
  const launchFailure = detectLaunchFailure(logPath)
  if (launchFailure) {
    return { turns: 0, complete: false, score: 0, total: promptCount, results: [], launchFailure }
  }
  const result = spawnSync(process.execPath, [CRITERIA, logPath, '--json'], {
    encoding: 'utf-8'
  })
  try {
    return JSON.parse(result.stdout)
  } catch {
    return { turns: 0, complete: false, score: 0, total: promptCount, results: [] }
  }
}

/**
 * Say when the app never started, instead of scoring the silence.
 *
 * A run that never launched produces a log with no turns in it, which grades as
 * zero — indistinguishable in the table from a model that answered every prompt
 * badly. That is the most expensive kind of wrong result here, because the
 * obvious reading is "the change I just made broke this".
 *
 * It happens for one known reason: a previous run's `electron-vite dev` server
 * survived `killTree`, still holding port 5173, so Electron starts and quits
 * against the single-instance lock without writing anything (see AGENTS.md).
 * The port message is the tell, and it is in the log every time.
 */
function detectLaunchFailure(logPath) {
  let text = ''
  try {
    text = readFileSync(logPath, 'utf-8')
  } catch {
    return 'no log was written at all'
  }
  const startedTurns = /TURN \d+\/\d+/.test(text)
  if (startedTurns) return null
  if (/Port \d+ is in use/.test(text)) {
    return 'a leftover dev server held the port; the app quit on the single-instance lock'
  }
  return 'the app produced no turns at all'
}

function renderTable(rows) {
  const header = 'model            ctx     turns  score  time'
  const lines = rows.map((row) => {
    if (row.skipped) return `${row.key.padEnd(16)} ${String(row.ctx).padEnd(7)} ${row.skipped}`
    if (row.launchFailure)
      return `${row.key.padEnd(16)} ${String(row.ctx).padEnd(7)} HARNESS FAILURE - ${row.launchFailure}`
    return (
      `${row.key.padEnd(16)} ${String(row.ctx).padEnd(7)} ` +
      `${String(row.turns ?? 0).padStart(2)}/${promptCount}  ${String(row.score ?? 0).padStart(2)}/${String(row.total ?? promptCount)}  ${row.seconds}s` +
      `${row.finished ? '' : '  TIMEOUT'}`
    )
  })
  return [header, ...lines].join('\n')
}
