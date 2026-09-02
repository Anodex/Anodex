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
const SCRIPT = join(process.cwd(), 'scripts/chat-script-matrix.json')

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
  { key: 'qwen27b-full', file: 'Qwen3.8-27B-UD-Q4_K_M.gguf', ctx: 65536 }
]

const [outDir, ...only] = process.argv.slice(2)
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
  console.log(
    `${entry.key}: ${graded.score}/${graded.total}  turns ${graded.turns}/10  ${seconds}s${finished ? '' : '  (TIMED OUT)'}`
  )
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
    const timer = setInterval(() => {
      let text = ''
      try {
        text = readFileSync(logPath, 'utf-8')
      } catch {
        text = ''
      }
      const done = /CHAT AUTORUN COMPLETE|Autorun failed/.test(text)
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
  const result = spawnSync(process.execPath, ['scripts/chat-criteria.mjs', logPath, '--json'], {
    encoding: 'utf-8'
  })
  try {
    return JSON.parse(result.stdout)
  } catch {
    return { turns: 0, complete: false, score: 0, total: 10, results: [] }
  }
}

function renderTable(rows) {
  const header = 'model            ctx     turns  score  time'
  const lines = rows.map((row) => {
    if (row.skipped) return `${row.key.padEnd(16)} ${String(row.ctx).padEnd(7)} ${row.skipped}`
    return (
      `${row.key.padEnd(16)} ${String(row.ctx).padEnd(7)} ` +
      `${String(row.turns ?? 0).padStart(2)}/10  ${String(row.score ?? 0).padStart(2)}/10  ${row.seconds}s` +
      `${row.finished ? '' : '  TIMEOUT'}`
    )
  })
  return [header, ...lines].join('\n')
}
