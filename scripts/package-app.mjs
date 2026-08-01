import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

/**
 * Package Anodex for the platform this script is running on.
 *
 * There is no target argument, and deliberately so: Anodex cannot be
 * cross-compiled. `prepare:vision` downloads the *host* platform's llama.cpp
 * runtime into `resources/llama-server/<platform>-<arch>`, and
 * `LlamaServerRuntime` looks for exactly that directory at runtime. A macOS
 * build produced on Windows would package a Windows runtime and fail the
 * moment a vision model loaded. Building each target on its own machine is a
 * property of the app, not a limitation of this script — see the CI packaging
 * workflow, which is how all three are produced.
 *
 * Any extra arguments are forwarded to electron-builder, so the documented
 * `npm run dist -- --publish always` works. (It did not before this script
 * existed: the arguments landed on the wrapper and were silently dropped.)
 */

const ROOT = resolve(import.meta.dirname, '..')
const electronBuilderCli = resolve(ROOT, 'node_modules', 'electron-builder', 'cli.js')
const passthrough = process.argv.slice(2)

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) {
        resolveRun()
        return
      }
      reject(new Error(`${command} exited with code ${code ?? 'unknown'}`))
    })
  })
}

function electronBuilder(args) {
  // `--publish never` first so a caller-supplied `--publish always` wins:
  // electron-builder takes the last occurrence.
  return run(process.execPath, [electronBuilderCli, ...args, '--publish', 'never', ...passthrough])
}

/**
 * Windows gets the branded two-stage build: the real NSIS installer, then the
 * Electron shell that wraps it and reports genuine install-stage milestones.
 * The NSIS bitmap art is generated here rather than in the `dist` script
 * because it is NSIS-specific — nothing outside Windows can use a 24-bit BMP
 * sidebar, and `sharp` should not run on platforms that have no use for it.
 */
async function packageWindows() {
  await run(process.execPath, [resolve(ROOT, 'scripts', 'generate-installer-art.mjs')])
  await electronBuilder(['--win', 'nsis'])
  await run(process.execPath, [
    electronBuilderCli,
    '--projectDir',
    'installer-shell',
    '--config',
    'electron-builder.yml',
    '--win',
    'portable',
    '--x64',
    '--publish',
    'never'
  ])
}

/**
 * An AppImage is a single executable file the user marks executable and runs —
 * there is no install step, so there is nothing for a branded installer shell
 * to wrap and none is built. This is the cheapest platform to ship: AppImages
 * require no code signing and no notarization.
 */
function packageLinux() {
  return electronBuilder(['--linux', 'AppImage'])
}

/**
 * Produces a .dmg. Note that an unsigned, un-notarized macOS build is
 * something current macOS makes genuinely difficult for an ordinary user to
 * open — this builds a real artifact, but not yet a distributable one. That
 * needs an Apple Developer ID certificate plus notarization.
 */
function packageMac() {
  return electronBuilder(['--mac', 'dmg'])
}

const packagers = {
  win32: packageWindows,
  linux: packageLinux,
  darwin: packageMac
}

const packageForHost = packagers[process.platform]
if (!packageForHost) {
  throw new Error(
    `No packaging path is defined for ${process.platform}. Supported: ${Object.keys(packagers).join(', ')}.`
  )
}

await packageForHost()
