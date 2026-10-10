import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import type { BackgroundProcessInfo } from '@shared/process.types'
import { createLogger } from '../utils/logger'

const log = createLogger('processes')

/** How much of each process's output is kept: the recent end, which is what matters. */
const MAX_OUTPUT_CHARS = 64 * 1024
/** A project's runaway loop of start calls stops here rather than at the machine's limit. */
export const MAX_RUNNING_PROCESSES = 6
/** Polite stop first; a process that ignores it is killed after this. */
const STOP_GRACE_MS = 3_000
/** Ended processes are kept a while so their output can still be read. */
const MAX_ENDED_KEPT = 20

/** The first local address a dev server announces, e.g. `http://localhost:5173/`. */
const LOCAL_URL =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{2,5})?(?:\/[^\s'"`<>)\]]*)?/i

interface Entry {
  info: BackgroundProcessInfo
  child: ChildProcess
  output: string
  /** Characters dropped from the front of `output` to keep it bounded. */
  dropped: number
  exited: Promise<void>
}

export interface StartOptions {
  command: string
  cwd: string
  name?: string
  projectId: string | null
  conversationId: string | null
  /** The shell to run it in; Node's platform default when absent. */
  shell?: string
}

/**
 * Processes Anodex starts and leaves running: a dev server, a watcher, a game
 * it just built. `run_command` cannot do this on purpose (it waits for the
 * command to exit and kills it at the timeout), so a model that built a web
 * app had to hand the person a command to run themselves.
 *
 * Each process runs in its own process group (on Windows, its own tree), so
 * stopping one stops what it started too: `npm run dev` is a shell, npm, and a
 * node server, and killing only the first leaves the server holding the port.
 * Every one is stopped when Anodex quits.
 */
export class BackgroundProcessService {
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<(info: BackgroundProcessInfo) => void>()

  start(options: StartOptions): BackgroundProcessInfo {
    const running = this.list().filter((info) => info.status === 'running')
    if (running.length >= MAX_RUNNING_PROCESSES) {
      throw new Error(
        `${running.length} background processes are already running. Stop one before starting another.`
      )
    }
    const id = randomUUID().slice(0, 8)
    const child = spawn(options.command, {
      cwd: options.cwd,
      shell: options.shell ?? true,
      // Its own process group, so a stop reaches everything it started. On
      // Windows `detached` opens a new console window instead; the tree kill
      // there goes through taskkill.
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' }
    })
    const info: BackgroundProcessInfo = {
      id,
      name: options.name?.trim() || defaultName(options.command),
      command: options.command,
      projectId: options.projectId,
      conversationId: options.conversationId,
      cwd: options.cwd,
      startedAt: Date.now(),
      status: 'running',
      exitCode: null,
      endedAt: null,
      url: null
    }
    let settle: () => void = () => undefined
    const entry: Entry = {
      info,
      child,
      output: '',
      dropped: 0,
      exited: new Promise<void>((resolve) => (settle = resolve))
    }
    this.entries.set(id, entry)

    const onData = (chunk: Buffer): void => this.append(entry, chunk.toString())
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (error) => {
      this.append(entry, `\n[could not start: ${error.message}]\n`)
      this.end(entry, 'failed', null)
      settle()
    })
    child.on('exit', (code) => {
      this.end(entry, entry.info.status === 'stopped' ? 'stopped' : 'exited', code)
      settle()
    })

    log.info('Started', id, JSON.stringify(options.command), 'in', options.cwd)
    this.emit(info)
    this.pruneEnded()
    return { ...info }
  }

  get(id: string): BackgroundProcessInfo | undefined {
    const entry = this.entries.get(id)
    return entry ? { ...entry.info } : undefined
  }

  /** Newest first. `projectId` narrows to one project's processes. */
  list(projectId?: string | null): BackgroundProcessInfo[] {
    return [...this.entries.values()]
      .map((entry) => ({ ...entry.info }))
      .filter((info) => projectId === undefined || info.projectId === projectId)
      .sort((a, b) => b.startedAt - a.startedAt)
  }

  /** The kept output, its last `maxChars` when given, and whether earlier output was dropped. */
  output(id: string, maxChars?: number): { text: string; truncated: boolean } | undefined {
    const entry = this.entries.get(id)
    if (!entry) return undefined
    const text =
      maxChars !== undefined && entry.output.length > maxChars
        ? entry.output.slice(-maxChars)
        : entry.output
    return { text, truncated: entry.dropped > 0 || text.length < entry.output.length }
  }

  /** Resolves once the process has ended, or after `ms`, whichever is first. */
  async waitForExit(id: string, ms: number): Promise<BackgroundProcessInfo | undefined> {
    const entry = this.entries.get(id)
    if (!entry) return undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      entry.exited,
      new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))
    ])
    if (timer) clearTimeout(timer)
    return this.get(id)
  }

  /** Stop a process and everything it started. Resolves when it has gone. */
  async stop(id: string): Promise<BackgroundProcessInfo | undefined> {
    const entry = this.entries.get(id)
    if (!entry) return undefined
    if (entry.info.status !== 'running') return { ...entry.info }
    entry.info.status = 'stopped'
    killTree(entry.child, 'SIGTERM')
    const ended = await this.waitForExit(id, STOP_GRACE_MS)
    if (ended?.endedAt === null) {
      killTree(entry.child, 'SIGKILL')
      await this.waitForExit(id, STOP_GRACE_MS)
    }
    return this.get(id)
  }

  /** Stop every running process, for quitting. */
  async stopAll(): Promise<void> {
    await Promise.all(
      this.list()
        .filter((info) => info.status === 'running')
        .map((info) => this.stop(info.id))
    )
  }

  /**
   * The last-resort stop on quit, which cannot wait: signal every tree to die
   * now. Used from `will-quit`, where nothing asynchronous is guaranteed to run.
   */
  killAllNow(): void {
    for (const entry of this.entries.values()) {
      if (entry.info.status !== 'running') continue
      entry.info.status = 'stopped'
      killTree(entry.child, 'SIGKILL')
    }
  }

  onChange(listener: (info: BackgroundProcessInfo) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private append(entry: Entry, text: string): void {
    entry.output += text
    if (entry.output.length > MAX_OUTPUT_CHARS) {
      const excess = entry.output.length - MAX_OUTPUT_CHARS
      entry.output = entry.output.slice(excess)
      entry.dropped += excess
    }
    if (!entry.info.url) {
      const match = LOCAL_URL.exec(text)
      if (match) {
        entry.info.url = match[0].replace('0.0.0.0', 'localhost').replace(/[.,;:]+$/, '')
        this.emit(entry.info)
      }
    }
  }

  private end(entry: Entry, status: BackgroundProcessInfo['status'], code: number | null): void {
    if (entry.info.endedAt !== null) return
    entry.info.status = status
    entry.info.exitCode = status === 'exited' ? code : null
    entry.info.endedAt = Date.now()
    log.info('Ended', entry.info.id, status, code)
    this.emit(entry.info)
  }

  private emit(info: BackgroundProcessInfo): void {
    for (const listener of this.listeners) listener({ ...info })
  }

  private pruneEnded(): void {
    const ended = this.list().filter((info) => info.status !== 'running')
    for (const info of ended.slice(MAX_ENDED_KEPT)) this.entries.delete(info.id)
  }
}

/** `npm run dev` from `npm run dev -- --port 3000`: enough to tell two apart. */
function defaultName(command: string): string {
  const words = command.trim().split(/\s+/).slice(0, 3).join(' ')
  return words.length > 40 ? `${words.slice(0, 39)}…` : words
}

/**
 * Signal a process and its descendants. A process group on POSIX (negative
 * pid); on Windows, taskkill's tree flag, since Windows has no groups to
 * signal and `child.kill()` would stop only the shell.
 */
function killTree(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
  if (child.pid === undefined) return
  try {
    if (process.platform === 'win32') {
      spawn(
        'taskkill',
        ['/pid', String(child.pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])],
        {
          windowsHide: true,
          stdio: 'ignore'
        }
      ).on('error', () => child.kill())
    } else {
      process.kill(-child.pid, signal)
    }
  } catch {
    // Already gone, or the group could not be signalled: fall back to the one
    // process we hold.
    try {
      child.kill(signal)
    } catch {
      /* already exited */
    }
  }
}

export const backgroundProcessService = new BackgroundProcessService()
