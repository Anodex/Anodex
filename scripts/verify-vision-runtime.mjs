import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { delimiter, dirname, join, resolve } from 'node:path'

/**
 * Prove the bundled llama.cpp runtime actually runs on this machine.
 *
 * Anodex cannot be cross-compiled: `prepare:vision` downloads the *host*
 * platform's llama.cpp, so the macOS and Linux runtimes only ever existed on
 * their own runners — and nothing ran them there until a tag was pushed, at
 * which point a broken runtime is a failed release rather than a failed pull
 * request. This is the check that moves that discovery earlier.
 *
 * It does what the app does, in the same order: resolve the binary through
 * the marker file, then start it with the library path the app sets. A
 * runtime whose shared libraries do not resolve fails here exactly as it
 * would in front of a user, which is the whole point — an `existsSync` on the
 * binary would have passed in every case worth catching.
 */

const ROOT = resolve(import.meta.dirname, '..')
const target = join(ROOT, 'resources', 'llama-server', `${process.platform}-${process.arch}`)
const markerPath = join(target, '.release.json')

function fail(message) {
  process.stderr.write(`verify-vision-runtime: ${message}\n`)
  process.exit(1)
}

if (!existsSync(markerPath)) {
  fail(`no runtime prepared for ${process.platform}-${process.arch}. Run npm run prepare:vision.`)
}

const marker = JSON.parse(await readFile(markerPath, 'utf8'))
if (!marker.binaryRelativePath) fail('the runtime manifest has no binaryRelativePath.')

const binaryPath = resolve(target, marker.binaryRelativePath)
if (!existsSync(binaryPath)) fail(`the manifest points at a missing binary: ${binaryPath}`)

// A tarball that lost its permission bits produces a binary that exists and
// cannot be started, which is the failure mode a file-existence check misses.
if (process.platform !== 'win32') {
  const mode = statSync(binaryPath).mode
  if ((mode & 0o111) === 0) fail(`the binary is not executable (mode ${mode.toString(8)}).`)
}

// llama.cpp's MIT notice has to travel with the binaries it covers.
if (!existsSync(join(target, 'LICENSE-llama.cpp.txt'))) {
  fail('LICENSE-llama.cpp.txt is missing from the prepared runtime.')
}

const binaryDir = dirname(binaryPath)
const libraryPathKey =
  process.platform === 'win32'
    ? 'PATH'
    : process.platform === 'darwin'
      ? 'DYLD_LIBRARY_PATH'
      : 'LD_LIBRARY_PATH'
const currentLibraryPath = process.env[libraryPathKey] ?? ''

const output = await new Promise((resolveOutput) => {
  const child = spawn(binaryPath, ['--version'], {
    cwd: binaryDir,
    env: {
      ...process.env,
      [libraryPathKey]: currentLibraryPath
        ? `${binaryDir}${delimiter}${currentLibraryPath}`
        : binaryDir
    }
  })

  let text = ''
  const collect = (chunk) => {
    text += chunk.toString('utf8')
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)

  // `--version` prints and exits immediately; anything still running after
  // this is hung, not slow.
  const timer = setTimeout(() => {
    child.kill('SIGKILL')
    resolveOutput({ code: null, text, timedOut: true })
  }, 60_000)

  child.once('error', (error) => {
    clearTimeout(timer)
    resolveOutput({ code: null, text: `${text}\n${error.message}`, spawnFailed: true })
  })
  child.once('close', (code) => {
    clearTimeout(timer)
    resolveOutput({ code, text })
  })
})

if (output.spawnFailed) fail(`the binary could not be started.\n${output.text}`)
if (output.timedOut) fail(`the binary did not exit within 60s.\n${output.text}`)
if (output.code !== 0) fail(`the binary exited ${output.code}.\n${output.text}`)

// llama.cpp prints its version to stderr, so the check is on the combined
// text rather than on stdout alone.
if (!/version/i.test(output.text)) {
  fail(`the binary ran but printed no version.\n${output.text}`)
}

process.stdout.write(
  `verify-vision-runtime: ${process.platform}-${process.arch} runs llama.cpp ` +
    `${marker.release} (${marker.asset}).\n${output.text.trim()}\n`
)
