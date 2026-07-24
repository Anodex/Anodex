import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { delimiter, dirname, join, resolve, sep } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { app } from 'electron'
import type { ModelLoadOptions } from '@shared/model.types'
import { createLogger } from '../utils/logger'

const log = createLogger('llama:vision-runtime')
const STARTUP_TIMEOUT_MS = 5 * 60_000
const HEALTH_POLL_MS = 300
const MAX_DIAGNOSTIC_CHARS = 16_000

interface RuntimeMarker {
  binaryRelativePath?: string
}

export interface LlamaServerConnection {
  baseUrl: string
  apiKey: string
  modelId: string
}

/**
 * Owns the private llama-server process used for multimodal local models.
 * It is never exposed to the network: the process binds to 127.0.0.1 on an
 * ephemeral port and requires a fresh random key for every load.
 */
export class LlamaServerRuntime {
  private child?: ChildProcessWithoutNullStreams
  private connection?: LlamaServerConnection
  private diagnosticOutput = ''
  private readonly expectedExits = new WeakSet<ChildProcessWithoutNullStreams>()
  /**
   * Details of the most recent process exit, captured whether or not it was
   * expected, so a mid-generation stream failure can report the real reason
   * (exit code + the tail of the process's own stdout/stderr) instead of the
   * bare `terminated` that `undici` throws when the connection drops.
   */
  private lastExit?: { code: number | null; signal: NodeJS.Signals | null; diagnostic: string }

  constructor(private readonly onUnexpectedExit?: (message: string) => void) {}

  get activeConnection(): LlamaServerConnection | undefined {
    return this.connection
  }

  async start(options: ModelLoadOptions): Promise<LlamaServerConnection> {
    if (!options.visionProjectorPath) {
      throw new Error('A multimodal projector is required to start local vision.')
    }
    await this.stop()

    const binaryPath = await resolveLlamaServerBinary()
    const port = await reserveLoopbackPort()
    const apiKey = randomBytes(24).toString('hex')
    const args = [
      '--model',
      options.path,
      '--mmproj',
      options.visionProjectorPath,
      '--ctx-size',
      String(options.contextSize ?? 8192),
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--api-key',
      apiKey,
      '--parallel',
      '1',
      '--jinja',
      '--no-webui',
      '--n-gpu-layers',
      String(
        options.gpuLayers === 'auto' || options.gpuLayers === undefined ? 999 : options.gpuLayers
      )
    ]
    if (options.gpuLayers === 0) args.push('--no-mmproj-offload')

    const binaryDir = dirname(binaryPath)
    const libraryPathKey =
      process.platform === 'win32'
        ? 'PATH'
        : process.platform === 'darwin'
          ? 'DYLD_LIBRARY_PATH'
          : 'LD_LIBRARY_PATH'
    const currentLibraryPath = process.env[libraryPathKey] ?? ''
    this.diagnosticOutput = ''
    const child = spawn(binaryPath, args, {
      cwd: binaryDir,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        [libraryPathKey]: currentLibraryPath
          ? `${binaryDir}${delimiter}${currentLibraryPath}`
          : binaryDir
      }
    })
    this.child = child

    const recordOutput = (chunk: Buffer): void => {
      this.diagnosticOutput = `${this.diagnosticOutput}${chunk.toString('utf8')}`.slice(
        -MAX_DIAGNOSTIC_CHARS
      )
    }
    child.stdout.on('data', recordOutput)
    child.stderr.on('data', recordOutput)
    child.once('exit', (code, signal) => {
      if (this.child === child) {
        this.child = undefined
        this.connection = undefined
      }
      this.lastExit = { code, signal, diagnostic: this.diagnosticOutput.trim() }
      if (!this.expectedExits.delete(child)) {
        const message = `The local vision runtime stopped unexpectedly (${code ?? signal ?? 'unknown'}). Reload the model to continue.`
        log.error(message)
        this.onUnexpectedExit?.(message)
      }
    })

    const origin = `http://127.0.0.1:${port}`
    const baseUrl = `${origin}/v1`
    try {
      await this.waitUntilReady(origin, apiKey, child)
      const modelId = await this.readModelId(baseUrl, apiKey)
      this.connection = { baseUrl, apiKey, modelId }
      log.info('Local vision runtime ready on loopback.')
      return this.connection
    } catch (error) {
      await this.stop()
      const detail = this.diagnosticOutput.trim()
      if (detail) log.error('llama-server startup output:', detail)
      throw new Error(
        detail
          ? `${error instanceof Error ? error.message : String(error)}\n\n${tailLines(detail, 18)}`
          : error instanceof Error
            ? error.message
            : String(error)
      )
    }
  }

  async stop(): Promise<void> {
    const child = this.child
    this.connection = undefined
    if (!child) return

    this.expectedExits.add(child)
    this.child = undefined
    const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()))
    child.kill()
    await Promise.race([exited, delay(2500)])
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await Promise.race([exited, delay(1000)])
    }
  }

  /**
   * Wait for the current child to finish exiting (or return immediately if none
   * is running). Lets a caught mid-stream error give the `exit` handler a
   * chance to record the exit code + stderr before a diagnostic is built.
   */
  async settleExit(timeoutMs = 1500): Promise<void> {
    const child = this.child
    if (!child) return
    await Promise.race([
      new Promise<void>((resolveExit) => child.once('exit', () => resolveExit())),
      delay(timeoutMs)
    ])
  }

  /**
   * A human-readable reason the runtime is no longer serving requests, when it
   * has stopped. Turns `undici`'s bare `terminated` — surfaced when the process
   * drops the connection mid-generation, most often an out-of-memory kill —
   * into an actionable message that names the real cause. Returns `undefined`
   * while the runtime is still connected (i.e. the failure was not a stop).
   */
  describeUnexpectedStop(): string | undefined {
    if (this.connection) return undefined
    const exit = this.lastExit
    const code = exit ? (exit.code ?? exit.signal ?? 'unknown') : 'unknown'
    const tail = exit?.diagnostic ? `\n\n${tailLines(exit.diagnostic, 12)}` : ''
    return (
      `The local vision model's runtime stopped unexpectedly (exit ${code}) while generating. ` +
      'This most often means it ran out of memory — reload the model, lower its context size, ' +
      `or choose a smaller vision model, then try again.${tail}`
    )
  }

  private async waitUntilReady(
    origin: string,
    apiKey: string,
    child: ChildProcessWithoutNullStreams
  ): Promise<void> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error('The bundled llama.cpp vision runtime stopped while loading the model.')
      }
      try {
        const response = await fetch(`${origin}/health`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(2000)
        })
        if (response.ok) return
        if (response.status !== 503) {
          throw new Error(`Vision runtime health check returned HTTP ${response.status}.`)
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes('health check returned')) throw error
      }
      await delay(HEALTH_POLL_MS)
    }
    throw new Error('Timed out while llama.cpp was loading the vision model.')
  }

  private async readModelId(baseUrl: string, apiKey: string): Promise<string> {
    const response = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    })
    if (!response.ok) return 'local-model'
    const body = (await response.json()) as { data?: Array<{ id?: string }> }
    return body.data?.[0]?.id || 'local-model'
  }
}

async function resolveLlamaServerBinary(): Promise<string> {
  const override = process.env.ANODEX_LLAMA_SERVER_PATH?.trim()
  if (override) {
    const resolved = resolve(override)
    if (!existsSync(resolved)) {
      throw new Error(`ANODEX_LLAMA_SERVER_PATH does not exist: ${resolved}`)
    }
    return resolved
  }

  const resourceRoot = app.isPackaged
    ? join(process.resourcesPath, 'llama-server')
    : join(process.cwd(), 'resources', 'llama-server')
  const target = join(resourceRoot, `${process.platform}-${process.arch}`)
  const markerPath = join(target, '.release.json')
  if (!existsSync(markerPath)) {
    throw new Error(
      app.isPackaged
        ? 'This Anodex build does not include its local vision runtime.'
        : 'The local vision runtime is not prepared. Run npm run prepare:vision, then try again.'
    )
  }

  const marker = JSON.parse(await readFile(markerPath, 'utf8')) as RuntimeMarker
  if (!marker.binaryRelativePath) {
    throw new Error('The bundled local vision runtime manifest is invalid.')
  }
  const binaryPath = resolve(target, marker.binaryRelativePath)
  const safeRoot = `${resolve(target)}${sep}`
  if (!binaryPath.startsWith(safeRoot) || !existsSync(binaryPath)) {
    throw new Error('The bundled local vision runtime is incomplete.')
  }
  return binaryPath
}

async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Could not reserve a local port for the vision runtime.'))
        return
      }
      const port = address.port
      server.close((error) => (error ? reject(error) : resolvePort(port)))
    })
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function tailLines(text: string, count: number): string {
  return text.split(/\r?\n/).slice(-count).join('\n')
}
