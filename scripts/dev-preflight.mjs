/**
 * Preflight for the development run (`dev.cmd`, or `npm run dev` by hand).
 *
 * Two things stop a dev run from being the app you just changed:
 *
 * 1. `npm run dist` stages the pinned llama.cpp runtime and the desktop-control
 *    helper into `resources/` before it packages. `npm run dev` never did, and
 *    both directories are gitignored, so a checkout runs without them: vision
 *    models fail to load with "the local vision runtime is not prepared" and
 *    desktop control reports itself unavailable. Neither happens in a release
 *    build, which is what makes a dev run look broken by comparison.
 *
 * 2. Electron takes a single-instance lock (`src/main/index.ts`). A second copy
 *    quits immediately *with status 0*, so the dev window never appears, and
 *    dev.cmd's error branch never fires because nothing reported an error.
 *
 * So this stages what is missing and clears an instance that would swallow the
 * run. Nothing here is fatal on its own: a failed download still leaves
 * text-only models working, so it warns and lets the app start anyway.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { setTimeout as delay } from 'node:timers/promises'

const ROOT = resolve(import.meta.dirname, '..')
const PLATFORM_KEY = `${process.platform}-${process.arch}`

function log(message) {
  process.stdout.write(`  ${message}\n`)
}

/** Runs one of the sibling `scripts/*.mjs` preparers. Returns whether it succeeded. */
function runPreparer(script) {
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts', script)], {
    cwd: ROOT,
    stdio: 'inherit'
  })
  return result.status === 0
}

/**
 * The preparer self-skips when the pinned release is already staged, so running
 * it every time is what keeps a dev run on the same runtime a package would get.
 */
function stageVisionRuntime() {
  if (!runPreparer('prepare-llama-server.mjs')) {
    log('')
    log('WARNING: could not stage the llama.cpp runtime.')
    log('Vision-capable local models will fail to load. Text-only models are unaffected.')
    log('')
  }
}

/** The helper is compiled from source, so this needs the .NET SDK rather than a download. */
function stageDesktopControl() {
  if (process.platform !== 'win32') return
  const helper = join(
    ROOT,
    'resources',
    'windows-control',
    'win32-x64',
    'Anodex.WindowsControl.exe'
  )
  if (existsSync(helper)) return

  const sdks = spawnSync('dotnet', ['--list-sdks'], { encoding: 'utf8' })
  if (sdks.status !== 0 || !sdks.stdout?.trim()) {
    log('Skipping desktop control: no .NET SDK found. Install the .NET 8 SDK and re-run')
    log('to test that feature; everything else works without it.')
    return
  }
  if (!runPreparer('prepare-windows-control.mjs')) {
    log('WARNING: the desktop-control helper failed to build; that feature will be unavailable.')
  }
}

/**
 * Anodex processes that already hold, or are about to hold, the single-instance
 * lock: the packaged app, an Electron main process from this checkout, and the
 * `electron-vite` server that owns one. Renderer and utility children carry a
 * `--type=` switch, which is what separates them from a main process.
 */
function findRunningInstances() {
  if (process.platform !== 'win32') return []

  const query =
    "Get-CimInstance Win32_Process -Filter \"Name='Anodex.exe' or Name='electron.exe' or Name='node.exe'\" " +
    '| Select-Object ProcessId,Name,CommandLine,ExecutablePath | ConvertTo-Json -Depth 2 -Compress'
  const probe = spawnSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', query],
    { encoding: 'utf8' }
  )
  if (probe.status !== 0 || !probe.stdout?.trim()) return []

  let rows
  try {
    rows = JSON.parse(probe.stdout)
  } catch {
    return []
  }
  if (!Array.isArray(rows)) rows = [rows]

  const here = ROOT.toLowerCase()
  const found = []
  for (const row of rows) {
    const pid = Number(row?.ProcessId)
    if (!pid || pid === process.pid) continue
    const name = String(row?.Name ?? '').toLowerCase()
    const command = String(row?.CommandLine ?? '')
    const image = String(row?.ExecutablePath ?? '').toLowerCase()

    if (name === 'anodex.exe' && !command.includes('--type=')) {
      found.push({ pid, label: 'the installed Anodex' })
    } else if (name === 'electron.exe' && image.startsWith(here) && !command.includes('--type=')) {
      found.push({ pid, label: 'a dev Anodex window' })
    } else if (name === 'node.exe' && command.includes('electron-vite') && command.includes(ROOT)) {
      found.push({ pid, label: 'a dev server from a previous run' })
    }
  }
  return found
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Asks the window to close first; only forces the ones that ignore it. Note the
 * absence of `/T`: the tree walk posts the close to Electron's renderer and GPU
 * children, which own no window and so can only be killed forcefully, and that
 * failure then blocks the parent. Closing the main process alone lets Electron
 * shut its own children down — and the electron-vite server exits with it.
 */
async function closeInstances(instances) {
  for (const { pid } of instances) {
    spawnSync('taskkill', ['/PID', String(pid)], { stdio: 'ignore' })
  }
  for (let waited = 0; waited < 8000 && instances.some((i) => isAlive(i.pid)); waited += 250) {
    await delay(250)
  }
  const stubborn = instances.filter((i) => isAlive(i.pid))
  for (const { pid } of stubborn) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  }
  await delay(500)
}

async function clearSingleInstanceLock() {
  const instances = findRunningInstances()
  if (instances.length === 0) return

  const labels = [...new Set(instances.map((i) => i.label))].join(' and ')
  log('')
  log(`Anodex is already running (${labels}).`)
  log('Electron allows one instance, so a new dev window would exit without opening.')

  if (!process.stdin.isTTY) {
    log('Close it and run this again, or the launch below will do nothing.')
    log('')
    return
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = (await rl.question('  Close it and continue? [Y/n] ')).trim().toLowerCase()
  rl.close()
  if (answer === 'n' || answer === 'no') {
    log('Left it running. The dev window will not open until it is closed.')
    log('')
    return
  }

  log('Closing...')
  await closeInstances(instances)
  log('')
}

log('')
log(`Preparing the development build for ${PLATFORM_KEY}...`)
stageVisionRuntime()
stageDesktopControl()
await clearSingleInstanceLock()
