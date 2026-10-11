import { execFile } from 'node:child_process'
import { accessSync, constants, statfsSync, statSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import os from 'node:os'
import { delimiter, join } from 'node:path'
import { formatBytes } from '@shared/format'
import type { ToolFactory } from './types'
import { runReadTool } from './helpers'

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
    description:
      'Check facts about this computer without running shell commands: "program" (is it installed, which version; give name), "port" (is it free; give port), "disk" (free space; optional path), or "system" (OS, CPU, memory).',
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
              return {
                modelResult: checkDisk(args.path?.trim() || ctx.workspaceRoot || os.homedir())
              }
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

async function checkProgram(name: string): Promise<string> {
  const program = name.trim()
  if (!PROGRAM_NAME.test(program)) {
    return 'Give just a program name, such as "java" or "git", not a path or a command.'
  }
  const found = findOnPath(program)
  if (!found) return `${program} is not installed (not found on PATH).`
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

function checkDisk(path: string): string {
  try {
    const stats = statfsSync(path)
    const free = Number(stats.bavail) * Number(stats.bsize)
    const total = Number(stats.blocks) * Number(stats.bsize)
    return `${formatBytes(free)} free of ${formatBytes(total)} on the disk holding ${path}.`
  } catch (error) {
    return `Could not measure ${path}: ${error instanceof Error ? error.message : String(error)}`
  }
}

function describeSystem(): string {
  const cpus = os.cpus()
  const names: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }
  return [
    `OS: ${names[process.platform] ?? process.platform} ${os.release()} (${os.arch()})`,
    `CPU: ${cpus[0]?.model.trim() ?? 'unknown'}, ${cpus.length} threads`,
    `Memory: ${formatBytes(os.freemem())} free of ${formatBytes(os.totalmem())}`,
    `Home folder: ${os.homedir()}`
  ].join('\n')
}
