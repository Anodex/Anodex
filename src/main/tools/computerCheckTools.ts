import { execFile } from 'node:child_process'
import { accessSync, constants, existsSync, statfsSync, statSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import os from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { formatBytes } from '@shared/format'
import type { ToolFactory } from './types'
import { runReadTool } from './helpers'
import type { KnownFolders } from './folderAccess'
import { expandHomeShorthand } from './homeShorthand'
import { readKnownFolders } from './knownFolders'
import { operatingSystemName } from '../chat/thisComputer'

/** A program name, not a path or a command line: nothing here runs what the model typed. */
const PROGRAM_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/
const VERSION_TIMEOUT_MS = 5_000
const PORT_TIMEOUT_MS = 1_000

type Check = 'program' | 'port' | 'disk' | 'system'

/**
 * check_computer — facts about this machine, asked directly instead of
 * guessed at through shell commands that differ on every platform: whether a
 * program is installed and which version, whether a port is free, how much
 * disk is left, and what the machine is.
 *
 * Read-only, so it never asks in any permission mode. The one thing it runs is
 * a program's own `--version` (`-version` for Java), found on PATH by name; it
 * never runs a path or a command line the model wrote.
 */
export const checkComputerTool: ToolFactory = (define, ctx) =>
  define({
    // Not "facts about this computer": the chat prompt says a fact gets a plain
    // answer, and measured with Llama 3.1 8B, once run_command stopped drawing
    // "What is the capital of France?" this tool drew it instead, on the word.
    description:
      'Look up this computer itself, without running shell commands: "program" (is it installed, which version; give name), "port" (is it free; give port), "disk" (free space; optional path), or "system" (OS, CPU, memory).',
    params: {
      type: 'object',
      properties: {
        check: {
          enum: ['program', 'port', 'disk', 'system'],
          description: 'What to check.'
        },
        name: { type: 'string', description: 'For "program": its name, e.g. "java" or "git".' },
        port: { type: 'number', description: 'For "port": the TCP port, e.g. 25565.' },
        path: { type: 'string', description: 'For "disk": a folder on the disk to measure.' }
      },
      required: ['check']
    } as const,
    handler: (args: { check: Check; name?: string; port?: number; path?: string }) =>
      runReadTool(ctx, {
        name: 'check_computer',
        kind: 'read',
        title: titleFor(args),
        args,
        async run() {
          switch (args.check) {
            case 'program':
              return { modelResult: await checkProgram(args.name ?? '') }
            case 'port':
              return { modelResult: await checkPort(args.port) }
            case 'disk':
              return checkDisk(diskPath(args.path, ctx.workspaceRoot, readKnownFolders()))
            case 'system':
              return { modelResult: describeSystem() }
            default:
              return {
                modelResult: 'Unknown check. Use "program", "port", "disk" or "system".',
                madeProgress: false
              }
          }
        }
      })
  })

function titleFor(args: { check: Check; name?: string; port?: number }): string {
  if (args.check === 'program') return `Check ${args.name ?? 'program'}`
  if (args.check === 'port') return `Check port ${args.port ?? ''}`.trim()
  if (args.check === 'disk') return 'Check disk space'
  return 'Check this computer'
}

/** Where `name` would run from, by the platform's own PATH rules, or null. */
export function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string | null {
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)
  const extensions =
    platform === 'win32'
      ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').map((ext) => ext.toLowerCase())
      : ['']
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = join(dir, name + ext)
      try {
        if (!statSync(candidate).isFile()) continue
        if (platform !== 'win32') accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        // not here
      }
    }
  }
  return null
}

/**
 * Programs known by more than one name, the name that runs first.
 *
 * Measured: asked "Is Node.js installed, and which version?", Llama 3.1 8B
 * checked "nodejs" and was told it was not installed, on a machine where
 * `node` was. The shell example this tool replaced said to check "under every
 * name it goes by"; the tool has to know the names itself.
 */
const PROGRAM_ALIASES: readonly (readonly string[])[] = [
  ['node', 'nodejs', 'node.js'],
  ['python', 'python3', 'py'],
  ['pip', 'pip3'],
  ['code', 'vscode', 'vs-code']
]

/** `name` first, then the other names of the program it is, if it has any. */
export function programNames(name: string): string[] {
  const lower = name.toLowerCase()
  const group = PROGRAM_ALIASES.find((names) => names.includes(lower))
  return [...new Set([name, lower, ...(group ?? [])])]
}

async function checkProgram(name: string): Promise<string> {
  const asked = name.trim()
  if (!PROGRAM_NAME.test(asked)) {
    return 'Give just a program name, such as "java" or "git", not a path or a command.'
  }
  let program = asked
  let found: string | null = null
  for (const candidate of programNames(asked)) {
    found = findOnPath(candidate)
    if (found) {
      program = candidate
      break
    }
  }
  if (!found) return `${asked} is not installed (not found on PATH under any name it goes by).`
  const flag = /^javac?$/i.test(program) ? '-version' : '--version'
  const version = await new Promise<string>((resolve) => {
    execFile(
      found,
      [flag],
      { timeout: VERSION_TIMEOUT_MS, windowsHide: true, shell: /\.(cmd|bat)$/i.test(found) },
      (_error, stdout, stderr) => {
        const first = `${stdout}\n${stderr}`.split(/\r?\n/).find((line) => line.trim())
        resolve(first?.trim().slice(0, 200) ?? '')
      }
    )
  })
  return version
    ? `${program} is installed at ${found}. Version: ${version}`
    : `${program} is installed at ${found} (it did not report a version).`
}

async function checkPort(port: number | undefined): Promise<string> {
  if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
    return 'Give a TCP port between 1 and 65535.'
  }
  // Something answering on it is the plainest sign it is taken; a bind that
  // fails catches a listener that only accepts on another address.
  const answering = await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const done = (value: boolean): void => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(PORT_TIMEOUT_MS, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
  if (answering) return `Port ${port} is in use: something on this computer is listening on it.`
  const bindable = await new Promise<boolean>((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, () => server.close(() => resolve(true)))
  })
  return bindable
    ? `Port ${port} is free.`
    : `Port ${port} is not available (it is in use, or needs administrator rights to open).`
}

/**
 * The folder whose disk to measure, read the way a person names one.
 *
 * - A home shorthand (`~`, `$HOME`...) means the home folder.
 * - A path starting with an everyday folder (`Documents`, `Downloads/old`)
 *   means that folder where this computer keeps it, as `request_folder_access`
 *   reads it.
 * - Anything else relative is read from the project, or from home without one.
 *
 * Never from the app's own working directory, which is where `statfs` would
 * otherwise resolve it. Measured with Gemma 4 E4B: "$HOME" became a folder of
 * that name inside the app, and "the drive my Documents folder is on" became
 * `Documents\Documents`, because a plain chat's working folder is Documents.
 * Not confined to the workspace: this reads a disk's free space, nothing inside
 * the folder.
 */
export function diskPath(
  requested: string | undefined,
  workspaceRoot: string | null | undefined,
  known: KnownFolders = {}
): string {
  const home = known.home ?? os.homedir()
  const raw = requested?.trim().replace(/^["']|["']$/g, '') ?? ''
  const base = workspaceRoot || home
  if (!raw) return base
  const fromHome = expandHomeShorthand(raw, home)
  if (fromHome) return fromHome
  if (isAbsolute(raw)) return resolve(raw)
  const [first, ...rest] = raw.split(/[\\/]/)
  const everyday = EVERYDAY_FOLDERS.has(first.toLowerCase())
    ? known[first.toLowerCase() as keyof KnownFolders]
    : undefined
  return everyday ? join(everyday, ...rest) : resolve(base, raw)
}

const EVERYDAY_FOLDERS: ReadonlySet<string> = new Set(['desktop', 'documents', 'downloads'])

/**
 * The deepest part of `path` that exists. Free space belongs to the disk, so a
 * folder not made yet ("is there room for it in Downloads/new-game?") is
 * answered by the disk it would be made on rather than refused.
 */
function nearestExisting(path: string): string {
  let current = path
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return current
}

function checkDisk(path: string): { modelResult: string; madeProgress?: false } {
  try {
    const stats = statfsSync(nearestExisting(path))
    const free = Number(stats.bavail) * Number(stats.bsize)
    const total = Number(stats.blocks) * Number(stats.bsize)
    return {
      modelResult: `${formatBytes(free)} free of ${formatBytes(total)} on the disk holding ${path}.`
    }
  } catch (error) {
    return {
      modelResult: `Could not measure ${path}: ${error instanceof Error ? error.message : String(error)}. Leave out "path" to measure the disk holding the home folder.`,
      madeProgress: false
    }
  }
}

function describeSystem(): string {
  const cpus = os.cpus()
  return [
    // The everyday name first, the build after it for anyone who needs it.
    `OS: ${operatingSystemName()} (build ${os.release()}, ${os.arch()})`,
    `CPU: ${cpus[0]?.model.trim() ?? 'unknown'}, ${cpus.length} threads`,
    `Memory: ${formatBytes(os.freemem())} free of ${formatBytes(os.totalmem())}`,
    `Home folder: ${os.homedir()}`
  ].join('\n')
}
