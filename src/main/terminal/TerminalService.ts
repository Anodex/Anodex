import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { createLogger } from '../utils/logger'

const log = createLogger('terminal')

const SHELL =
  process.platform === 'win32' ? process.env.COMSPEC || 'cmd.exe' : process.env.SHELL || '/bin/bash'

interface Session {
  id: string
  process: ChildProcess
}

/**
 * Runs real shell sessions for the Workspace Dock's Terminal panel.
 *
 * Uses `child_process.spawn` over plain pipes rather than `node-pty` — this
 * avoids `node-pty`'s native compilation step (a real cost for an
 * Electron app's install/build story) at the expense of not being a true
 * PTY: `resize()` below is a no-op, and programs that check `isatty()` or
 * rely on terminal control sequences (`vim`, interactive prompts, `git`'s
 * pager) won't behave like they would in a real terminal emulator. Fine for
 * the common case (running a build, `git status`, `npm test`); `node-pty`
 * remains the natural upgrade if full interactivity is ever needed.
 */
export class TerminalService {
  private sessions = new Map<string, Session>()
  private dataListeners: Array<(payload: { sessionId: string; data: string }) => void> = []
  private exitListeners: Array<(payload: { sessionId: string }) => void> = []

  /** Starts a new shell session rooted at `cwd` (falls back to the shell's own default). */
  create(cwd?: string): string {
    const id = randomUUID()
    const proc = spawn(SHELL, [], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TERM: 'xterm-256color' }
    })

    const session: Session = { id, process: proc }
    this.sessions.set(id, session)
    log.info('Session started', id, 'cwd:', cwd ?? '(shell default)')

    // Without an 'error' listener, a write to a stream that failed to start
    // (e.g. the shell binary doesn't exist) would throw an uncaught
    // exception in the main process instead of just failing this session.
    proc.stdin?.on('error', () => {
      /* Surfaced via the process 'error'/'exit' handlers below. */
    })

    proc.stdout?.on('data', (chunk: Buffer) => {
      this.emitData(id, chunk.toString())
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      this.emitData(id, chunk.toString())
    })

    proc.on('exit', (code) => {
      log.info('Session exited', id, 'code:', code)
      this.sessions.delete(id)
      this.emitExit(id)
    })

    proc.on('error', (error) => {
      log.error('Session error', id, error)
      this.sessions.delete(id)
      this.emitExit(id)
    })

    return id
  }

  write(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.process.stdin?.write(data)
  }

  resize(_sessionId: string, _cols: number, _rows: number): void {
    // No-op without node-pty — see the class doc comment above. A real PTY
    // would send SIGWINCH or call pty.resize(); basic shell commands still
    // work fine, but output that adapts to terminal width won't reflow.
  }

  kill(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.process.kill()
    this.sessions.delete(sessionId)
  }

  onData(listener: (payload: { sessionId: string; data: string }) => void): () => void {
    this.dataListeners.push(listener)
    return () => {
      this.dataListeners = this.dataListeners.filter((l) => l !== listener)
    }
  }

  onExit(listener: (payload: { sessionId: string }) => void): () => void {
    this.exitListeners.push(listener)
    return () => {
      this.exitListeners = this.exitListeners.filter((l) => l !== listener)
    }
  }

  private emitData(sessionId: string, data: string): void {
    for (const listener of this.dataListeners) listener({ sessionId, data })
  }

  private emitExit(sessionId: string): void {
    for (const listener of this.exitListeners) listener({ sessionId })
  }
}

export const terminalService = new TerminalService()
