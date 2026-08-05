import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelLoadOptions } from '@shared/model.types'

/**
 * First coverage for the supervisor of the private llama-server process used
 * by local vision. The process itself cannot be started in a test, so
 * `node:child_process` is faked and the interesting behaviour — what happens
 * when the spawn fails, when health refuses, when the server goes quiet — is
 * driven through that fake.
 */

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true
    this.exitCode = 0
    this.emit('exit', 0, signal ?? null)
    return true
  }
}

let child: FakeChild
/**
 * Set by a test to make the next spawn fail. Delivered asynchronously, as Node
 * does — emitting it synchronously would fire before `start` has attached its
 * listener, and an unlistened `error` on an EventEmitter throws, which is the
 * very failure this file exists to prevent.
 */
let pendingSpawnError: Error | null = null
const spawn = vi.fn((_binary: string, _args: string[], _options?: unknown) => {
  if (pendingSpawnError) {
    const failure = pendingSpawnError
    pendingSpawnError = null
    setTimeout(() => child.emit('error', failure), 0)
  }
  return child
})

vi.mock('node:child_process', () => ({ spawn }))
vi.mock('electron', () => ({ app: { isPackaged: false } }))

const { LlamaServerRuntime } = await import('../LlamaServerRuntime')

let runtimeRoot = ''
let originalCwd: () => string

/** A prepared runtime directory, so `resolveLlamaServerBinary` finds a binary. */
function prepareRuntimeDir(): void {
  runtimeRoot = mkdtempSync(join(tmpdir(), 'anodex-vision-runtime-'))
  const target = join(
    runtimeRoot,
    'resources',
    'llama-server',
    `${process.platform}-${process.arch}`
  )
  mkdirSync(target, { recursive: true })
  writeFileSync(
    join(target, '.release.json'),
    JSON.stringify({ binaryRelativePath: 'llama-server' })
  )
  writeFileSync(join(target, 'llama-server'), 'binary')
}

function options(): ModelLoadOptions {
  return {
    path: '/models/vision.gguf',
    visionProjectorPath: '/models/mmproj.gguf',
    contextSize: 4096
  }
}

/** The slice of `Response` this file's code paths actually read. */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body)
  } as unknown as Response
}

/** Reply to each fetch by URL suffix; anything unmatched 503s like a loading server. */
function respond(handlers: Record<string, () => Promise<Response> | Response>): void {
  globalThis.fetch = vi.fn((input: string | URL) => {
    const url = String(input)
    const key = Object.keys(handlers).find((suffix) => url.includes(suffix))
    if (!key) {
      return Promise.resolve(jsonResponse({}, 503))
    }
    return Promise.resolve(handlers[key]())
  }) as unknown as typeof fetch
}

beforeEach(() => {
  vi.clearAllMocks()
  child = new FakeChild()
  pendingSpawnError = null
  prepareRuntimeDir()
  originalCwd = process.cwd.bind(process)
  process.cwd = () => runtimeRoot
})

afterEach(() => {
  process.cwd = originalCwd
  rmSync(runtimeRoot, { recursive: true, force: true })
})

describe('start', () => {
  it('reports a spawn failure straight away instead of polling a dead port', async () => {
    respond({})
    // Node reports a binary that will not execute as an `error` event, not an
    // exit — so `exitCode` stays null and the liveness check never fires.
    pendingSpawnError = new Error('spawn EACCES')

    await expect(new LlamaServerRuntime().start(options())).rejects.toThrow(
      /could not be started: spawn EACCES/
    )
  })

  it('does not treat a spawn error as an unexpected exit worth warning about', async () => {
    respond({})
    const onUnexpectedExit = vi.fn()
    pendingSpawnError = new Error('spawn EACCES')
    await expect(new LlamaServerRuntime(onUnexpectedExit).start(options())).rejects.toThrow()

    // `stop()` kills the child on the way out; that exit is expected.
    expect(onUnexpectedExit).not.toHaveBeenCalled()
  })

  it('gives up on a health response that will never improve', async () => {
    respond({ '/health': () => jsonResponse({}, 401) })

    await expect(new LlamaServerRuntime().start(options())).rejects.toThrow(/HTTP 401/)
  })

  it('keeps waiting while the server reports it is still loading', async () => {
    let calls = 0
    respond({
      '/health': () => {
        calls += 1
        return jsonResponse({}, calls < 3 ? 503 : 200)
      },
      '/models': () => jsonResponse({ data: [{ id: 'vision-7b' }] })
    })

    const connection = await new LlamaServerRuntime().start(options())

    expect(calls).toBeGreaterThanOrEqual(3)
    expect(connection.modelId).toBe('vision-7b')
  })

  it('stops when the process exits during loading', async () => {
    respond({})
    const runtime = new LlamaServerRuntime()
    const starting = runtime.start(options())
    child.exitCode = 1
    child.emit('exit', 1, null)

    await expect(starting).rejects.toThrow(/stopped while loading/)
  })

  it('binds to loopback with a fresh key and a single slot', async () => {
    respond({ '/health': () => jsonResponse({}), '/models': () => jsonResponse({ data: [] }) })

    const connection = await new LlamaServerRuntime().start(options())
    const args = spawn.mock.calls[0][1]

    expect(args).toContain('127.0.0.1')
    expect(args[args.indexOf('--api-key') + 1]).toHaveLength(48)
    expect(args[args.indexOf('--parallel') + 1]).toBe('1')
    expect(connection.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    // A key generated per load, never a constant.
    expect(connection.apiKey).toBe(args[args.indexOf('--api-key') + 1])
  })

  it('refuses to start without a projector', async () => {
    await expect(new LlamaServerRuntime().start({ path: '/m.gguf' })).rejects.toThrow(
      /multimodal projector is required/
    )
  })
})

describe('readModelId', () => {
  /**
   * The one fetch in this file that had no timeout. Health has already passed
   * by this point, so a server that accepts the connection and never answers
   * used to hang `start()` for good — past the startup timeout it had already
   * satisfied, with nothing left to fail the load.
   */
  it('falls back to a placeholder rather than hanging when the id cannot be read', async () => {
    respond({
      '/health': () => jsonResponse({}),
      '/models': () => Promise.reject(new Error('TimeoutError'))
    })

    const connection = await new LlamaServerRuntime().start(options())

    expect(connection.modelId).toBe('local-model')
  })

  it('falls back when the server answers without naming a model', async () => {
    respond({ '/health': () => jsonResponse({}), '/models': () => jsonResponse({ data: [] }) })

    expect((await new LlamaServerRuntime().start(options())).modelId).toBe('local-model')
  })
})

describe('lifecycle', () => {
  async function started(): Promise<InstanceType<typeof LlamaServerRuntime>> {
    respond({
      '/health': () => jsonResponse({}),
      '/models': () => jsonResponse({ data: [{ id: 'vision-7b' }] })
    })
    const runtime = new LlamaServerRuntime()
    await runtime.start(options())
    return runtime
  }

  it('reports a crash the app did not ask for', async () => {
    respond({
      '/health': () => jsonResponse({}),
      '/models': () => jsonResponse({ data: [{ id: 'vision-7b' }] })
    })
    const onUnexpectedExit = vi.fn()
    const runtime = new LlamaServerRuntime(onUnexpectedExit)
    await runtime.start(options())

    child.exitCode = 137
    child.emit('exit', 137, null)

    expect(onUnexpectedExit).toHaveBeenCalledWith(expect.stringContaining('stopped unexpectedly'))
    expect(runtime.activeConnection).toBeUndefined()
  })

  it('stays quiet about an exit it asked for', async () => {
    respond({
      '/health': () => jsonResponse({}),
      '/models': () => jsonResponse({ data: [{ id: 'vision-7b' }] })
    })
    const onUnexpectedExit = vi.fn()
    const runtime = new LlamaServerRuntime(onUnexpectedExit)
    await runtime.start(options())

    await runtime.stop()

    expect(onUnexpectedExit).not.toHaveBeenCalled()
    expect(runtime.activeConnection).toBeUndefined()
  })

  it('explains a mid-generation stop with the exit code and the process output', async () => {
    const runtime = await started()
    child.stderr.emit('data', Buffer.from('ggml_backend_cuda: out of memory'))
    child.exitCode = 137
    child.emit('exit', 137, null)

    const reason = runtime.describeUnexpectedStop()

    expect(reason).toContain('exit 137')
    expect(reason).toContain('out of memory')
  })

  it('says nothing about a stop while it is still connected', async () => {
    const runtime = await started()

    expect(runtime.describeUnexpectedStop()).toBeUndefined()
  })
})

describe('countTokens', () => {
  async function connected(): Promise<InstanceType<typeof LlamaServerRuntime>> {
    respond({
      '/health': () => jsonResponse({}),
      '/models': () => jsonResponse({ data: [{ id: 'vision-7b' }] })
    })
    const runtime = new LlamaServerRuntime()
    await runtime.start(options())
    return runtime
  }

  it('measures with the model tokenizer', async () => {
    const runtime = await connected()
    respond({ '/tokenize': () => jsonResponse({ tokens: [1, 2, 3, 4] }) })

    expect(await runtime.countTokens('hello')).toBe(4)
  })

  it('returns null rather than a guess when the runtime is not running', async () => {
    expect(await new LlamaServerRuntime().countTokens('hello')).toBeNull()
  })

  // A wrong-but-plausible count truncates replies mid-sentence; "no
  // measurement" has to mean "do not clamp", never "clamp against a guess".
  it('returns null when the server answers with something unexpected', async () => {
    const runtime = await connected()
    respond({ '/tokenize': () => jsonResponse({ tokens: 'not-an-array' }) })

    expect(await runtime.countTokens('hello')).toBeNull()
  })

  it('returns null when tokenizing fails outright', async () => {
    const runtime = await connected()
    respond({ '/tokenize': () => Promise.reject(new Error('socket hang up')) })

    expect(await runtime.countTokens('hello')).toBeNull()
  })
})
