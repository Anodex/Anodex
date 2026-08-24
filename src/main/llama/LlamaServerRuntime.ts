import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { delimiter, dirname, join, resolve, sep } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { app } from 'electron'
import type { ModelLoadOptions } from '@shared/model.types'
import { createLogger } from '../utils/logger'
import { reasoningBudgetTokens } from './reasoningOverrun'

const log = createLogger('llama:vision-runtime')
const STARTUP_TIMEOUT_MS = 5 * 60_000
const HEALTH_POLL_MS = 300
const MAX_DIAGNOSTIC_CHARS = 16_000
/** Tokenizing is a local, CPU-only call; anything slower than this is a fault, not load. */
const TOKENIZE_TIMEOUT_MS = 10_000
/** Reading the model id happens after health has passed, so it should be immediate. */
const MODEL_ID_TIMEOUT_MS = 10_000
/** Used when the server will not name its model; it is a label, not an identifier we act on. */
const FALLBACK_MODEL_ID = 'local-model'

interface RuntimeMarker {
  binaryRelativePath?: string
}

export interface LlamaServerConnection {
  /** OpenAI-compatible root (`<origin>/v1`) for chat completions. */
  baseUrl: string
  /**
   * Server root, without the `/v1` suffix. llama.cpp's own non-OpenAI
   * endpoints (`/tokenize`, `/health`) live here, and `countTokens` needs one
   * to measure a prompt with the model's real tokenizer instead of guessing.
   */
  origin: string
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
  /** See `reportTokenizeUnavailable` — keeps a persistent fault from spamming the log. */
  private warnedTokenizeUnavailable = false

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
    // Close a runaway thought and let the round continue into its answer or
    // tool call, instead of spending the whole reply allowance thinking. This
    // is the transport's counterpart to node-llama-cpp's `budgets.thoughtTokens`
    // — see `reasoningOverrun.ts` for the measurements, and for why cutting the
    // stream from this side instead does not work. A no-op for a model that
    // emits no reasoning, and safe to pass unconditionally because the binary
    // is the bundled one (`resolveLlamaServerBinary`), not whatever is on PATH.
    const reasoningBudget = reasoningBudgetTokens(options.contextSize)
    if (reasoningBudget !== null) args.push('--reasoning-budget', String(reasoningBudget))

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

    /**
     * A spawn that never happened — the binary is not executable, or vanished
     * between the existence check and here.
     *
     * Node reports that as an `error` event rather than an exit, and this had
     * no listener for it. Two things followed. `ChildProcess` is an
     * `EventEmitter`, so an unlistened `error` is rethrown as an uncaught
     * exception, which the app's crash handler logged as an unrelated
     * "Unhandled error". And because the process never started, `exitCode` and
     * `signalCode` both stay null, so `waitUntilReady`'s liveness check never
     * fired and it polled a port nothing was listening on for the full
     * five-minute startup timeout — then blamed the model for loading slowly.
     * A failure known in milliseconds, reported five minutes later as the wrong
     * thing.
     */
    let spawnFailure: Error | undefined
    child.once('error', (error: Error) => {
      spawnFailure = error
      log.error('The local vision runtime could not be started:', error)
    })
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
      await this.waitUntilReady(origin, apiKey, child, () => spawnFailure)
      const modelId = await this.readModelId(baseUrl, apiKey)
      this.connection = { baseUrl, origin, apiKey, modelId }
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

  /**
   * Tail of the running process's own stdout/stderr.
   *
   * Startup failures and unexpected exits already fold this in, but a
   * mid-generation failure used to discard it entirely — leaving no record of
   * llama-server's own account of why a request went wrong (its per-request
   * stop reason and decoded-token count print here). Exposed for logging only:
   * this output can contain fragments of the rendered prompt, so it must not
   * be surfaced in the UI.
   */
  recentOutput(lines = 12): string | undefined {
    const text = this.diagnosticOutput.trim()
    return text ? tailLines(text, lines) : undefined
  }

  /**
   * Number of tokens `text` occupies under the loaded model's real tokenizer,
   * or `null` when the server can't answer — not running, an older build
   * without `/tokenize`, or any transport failure.
   *
   * Returning `null` instead of a character-based estimate is deliberate. The
   * caller sizes a generation's output ceiling from this, and a
   * wrong-but-plausible number there truncates replies mid-sentence (or, worse,
   * mid-tool-call) with nothing to show for it. "No measurement" has to mean
   * "don't clamp", never "clamp against a guess".
   */
  async countTokens(text: string): Promise<number | null> {
    const connection = this.connection
    if (!connection) return null
    try {
      const response = await fetch(`${connection.origin}/tokenize`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${connection.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ content: text }),
        signal: AbortSignal.timeout(TOKENIZE_TIMEOUT_MS)
      })
      if (!response.ok) return this.reportTokenizeUnavailable(`HTTP ${response.status}`)
      const body = (await response.json()) as { tokens?: unknown }
      if (!Array.isArray(body.tokens)) return this.reportTokenizeUnavailable('unexpected response')
      return body.tokens.length
    } catch (error) {
      return this.reportTokenizeUnavailable(error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * Warn once per process, not per call: a runtime that can't tokenize will
   * fail on every turn, and the useful signal is that it happened at all.
   */
  private reportTokenizeUnavailable(reason: string): null {
    if (!this.warnedTokenizeUnavailable) {
      this.warnedTokenizeUnavailable = true
      log.warn(
        `Could not measure tokens with the local runtime (${reason}). ` +
          'Output budgets will not be clamped for this session.'
      )
    }
    return null
  }

  private async waitUntilReady(
    origin: string,
    apiKey: string,
    child: ChildProcessWithoutNullStreams,
    spawnFailure: () => Error | undefined
  ): Promise<void> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    while (Date.now() < deadline) {
      const failed = spawnFailure()
      if (failed) {
        throw new Error(
          `The bundled llama.cpp vision runtime could not be started: ${failed.message}`
        )
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error('The bundled llama.cpp vision runtime stopped while loading the model.')
      }
      try {
        const response = await fetch(`${origin}/health`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(2000)
        })
        if (response.ok) return
        // 503 is llama.cpp saying "still loading the model", which is the whole
        // reason this polls. Anything else — 401 from a key mismatch, 404 from
        // a build without the endpoint — will not improve by asking again.
        if (response.status !== 503) {
          throw new HealthCheckRejected(
            `Vision runtime health check returned HTTP ${response.status}.`
          )
        }
      } catch (error) {
        // Rethrown by type rather than by matching on the message, which is
        // what this used to do: `error.message.includes('health check
        // returned')`. Rewording the string above would silently have turned a
        // fail-fast into a five-minute poll, with nothing to catch it.
        if (error instanceof HealthCheckRejected) throw error
        // Everything else is the port not accepting connections yet.
      }
      await delay(HEALTH_POLL_MS)
    }
    throw new Error('Timed out while llama.cpp was loading the vision model.')
  }

  /**
   * The model's own id, or a usable stand-in.
   *
   * Bounded and degrading, because by this point health has already answered:
   * the server is up and the load has succeeded, and the id is a label. This
   * call previously had no timeout at all — the one fetch in this file without
   * one — so a server that accepted the connection and never replied hung
   * `start()` for good, past the startup timeout that had already been
   * satisfied, leaving the model stuck loading with nothing left to fail it.
   */
  private async readModelId(baseUrl: string, apiKey: string): Promise<string> {
    try {
      const response = await fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(MODEL_ID_TIMEOUT_MS)
      })
      if (!response.ok) return FALLBACK_MODEL_ID
      const body = (await response.json()) as { data?: Array<{ id?: string }> }
      return body.data?.[0]?.id || FALLBACK_MODEL_ID
    } catch (error) {
      log.warn('Could not read the local vision model id; using a placeholder.', error)
      return FALLBACK_MODEL_ID
    }
  }
}

/** A health response that will not improve by polling — see `waitUntilReady`. */
class HealthCheckRejected extends Error {}

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
