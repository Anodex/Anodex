import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const electronBuilderCli = resolve(ROOT, 'node_modules', 'electron-builder', 'cli.js')

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: 'inherit'
    })

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

await run(process.execPath, [electronBuilderCli, '--win', 'nsis', '--publish', 'never'])
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
