import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

if (process.platform !== 'win32') process.exit(0)

const project = resolve(root, 'native', 'windows-control', 'Anodex.WindowsControl.csproj')
const output = resolve(root, 'resources', 'windows-control', 'win32-x64')
await new Promise((resolvePublish, reject) => {
  const child = spawn(
    'dotnet',
    [
      'publish',
      project,
      '-c',
      'Release',
      '-r',
      'win-x64',
      '--self-contained',
      'true',
      '-o',
      output
    ],
    { cwd: root, stdio: 'inherit' }
  )
  child.once('error', reject)
  child.once('exit', (code) => {
    if (code === 0) resolvePublish()
    else reject(new Error(`dotnet publish exited with ${code ?? 'unknown'}`))
  })
})
