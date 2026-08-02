import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelInfo } from '@shared/model.types'
import { llamaService, GENERATION_IN_PROGRESS_ERROR } from '../LlamaService'

/**
 * Lifecycle invariants for the shared local engine — the ones that decide
 * whether the engine survives a bad turn, not whether a turn produces good
 * text (`generateContextShiftRecovery.test.ts` covers that).
 *
 * Like that file, this reaches into `LlamaService`'s private fields rather than
 * driving a real `loadModel()`: the singleton has no injection seam for its
 * native model/session, and pre-seeding `session`/`activeConversationId` hits
 * `ensureSession`'s fast path, so no fake `node-llama-cpp` module is needed.
 */

interface LlamaServiceTestAccess {
  status: string
  context: unknown
  contextSize: number | undefined
  model: unknown
  currentModel: ModelInfo | undefined
  refusedLoad: unknown
  llama: unknown
  llamaPromise: Promise<unknown> | undefined
  session: unknown
  activeConversationId: string | undefined
  generating: boolean
  getModule: () => Promise<unknown>
}

function asTestAccess(): LlamaServiceTestAccess {
  return llamaService as unknown as LlamaServiceTestAccess
}

const fakeChatWrapper = {
  generateContextState: ({ chatHistory }: { chatHistory: unknown[] }) => ({
    contextText: { tokenize: () => Array.from({ length: 100 + chatHistory.length * 10 }) }
  })
}

function prepareFakeEngine(): LlamaServiceTestAccess {
  const access = asTestAccess()
  access.status = 'ready'
  access.context = { dispose: vi.fn() }
  access.contextSize = 8_192
  access.model = { tokenizer: () => [], dispose: vi.fn() }
  access.activeConversationId = 'test-conversation'
  return access
}

function generateOnce(): Promise<unknown> {
  return llamaService.generate({
    conversationId: 'test-conversation',
    messageId: 'test-message',
    history: [],
    prompt: 'say something',
    onToken: () => {}
  })
}

/** Let queued microtasks and timers run so an awaiting caller can make progress. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  vi.restoreAllMocks()
  const access = asTestAccess()
  access.status = 'unloaded'
  access.context = undefined
  access.contextSize = undefined
  access.model = undefined
  access.currentModel = undefined
  access.refusedLoad = undefined
  access.llama = undefined
  access.llamaPromise = undefined
  access.session = undefined
  access.activeConversationId = undefined
  access.generating = false
})

describe('LlamaService generation flag', () => {
  it('clears the generating flag when turn setup throws before the decode loop', async () => {
    const access = prepareFakeEngine()
    // `measureContextBudget` reads the session's history, and runs *after* the
    // three ad-hoc catches that used to be the only thing resetting this flag
    // but *before* the main try/finally — the exact uncovered window.
    access.session = {
      promptWithMeta: vi.fn(),
      dispose: vi.fn(),
      chatWrapper: fakeChatWrapper,
      getChatHistory: () => {
        throw new Error('history read failed')
      }
    }

    await expect(generateOnce()).rejects.toThrow('history read failed')

    expect(llamaService.isGenerating()).toBe(false)
    expect(llamaService.getState().generating).toBe(false)
  })

  it('accepts a new turn after a turn whose setup threw', async () => {
    const access = prepareFakeEngine()
    access.session = {
      promptWithMeta: vi.fn(),
      dispose: vi.fn(),
      chatWrapper: fakeChatWrapper,
      getChatHistory: () => {
        throw new Error('history read failed')
      }
    }
    await expect(generateOnce()).rejects.toThrow('history read failed')

    // A stuck flag reported itself as mere contention, which is worse than a
    // plain failure: `AgentRunService` and `CriticalThinkingService` both treat
    // GENERATION_IN_PROGRESS_ERROR as transient and retry against it forever.
    access.session = {
      promptWithMeta: vi.fn(() =>
        Promise.resolve({ response: [], responseText: 'recovered', stopReason: 'eogToken' })
      ),
      dispose: vi.fn(),
      chatWrapper: fakeChatWrapper,
      getChatHistory: () => [{ type: 'system', text: 'Test system prompt.' }]
    }

    const outcome = (await generateOnce()) as { content: string }
    expect(outcome.content).toBe('recovered')
  })

  it('does not report contention while the engine is idle', async () => {
    const access = prepareFakeEngine()
    access.session = {
      promptWithMeta: vi.fn(() =>
        Promise.resolve({ response: [], responseText: 'first', stopReason: 'eogToken' })
      ),
      dispose: vi.fn(),
      chatWrapper: fakeChatWrapper,
      getChatHistory: () => [{ type: 'system', text: 'Test system prompt.' }]
    }

    await generateOnce()
    await expect(generateOnce()).resolves.toBeDefined()
    expect(GENERATION_IN_PROGRESS_ERROR).toBe('A response is already being generated.')
  })
})

describe('LlamaService model lock', () => {
  it('waits for an in-flight generation before disposing the model', async () => {
    const access = prepareFakeEngine()
    let finishPrompt!: () => void
    const promptStarted = new Promise<void>((resolve) => {
      finishPrompt = resolve
    })
    const dispose = vi.fn()
    access.session = {
      promptWithMeta: vi.fn(
        () =>
          new Promise((resolvePrompt) => {
            void promptStarted.then(() =>
              resolvePrompt({ response: [], responseText: 'done', stopReason: 'eogToken' })
            )
          })
      ),
      dispose,
      chatWrapper: fakeChatWrapper,
      getChatHistory: () => [{ type: 'system', text: 'Test system prompt.' }]
    }

    const generation = generateOnce()
    await settle()
    expect(llamaService.isGenerating()).toBe(true)

    const unloading = llamaService.unload()
    await settle()

    // Unloading disposes the very context the decode is running on. Doing it
    // now is a native crash, not a catchable error.
    expect(dispose).not.toHaveBeenCalled()
    expect(llamaService.getState().status).toBe('ready')

    finishPrompt()
    await generation
    await unloading

    expect(dispose).toHaveBeenCalled()
    expect(llamaService.getState().status).toBe('unloaded')
  })
})

/**
 * `sizeBytes` no real machine can have free, so `describeInsufficientMemory`
 * refuses deterministically without having to fake `os.freemem()`. Paired with
 * a `getModule` whose GGUF read rejects, which drops the estimator into its
 * documented file-size fallback rather than depending on a real `.gguf`.
 */
const OVERSIZED_MODEL: ModelInfo = {
  id: 'oversized',
  name: 'Oversized Model',
  path: 'C:/models/oversized.gguf',
  sizeBytes: 2 ** 60,
  source: 'local'
}

const LOADED_MODEL: ModelInfo = {
  id: 'loaded',
  name: 'Loaded Model',
  path: 'C:/models/loaded.gguf',
  sizeBytes: 4 * 1024 ** 3,
  source: 'local'
}

/** A ready engine with `LOADED_MODEL` live, plus a working chat session. */
function prepareLoadedEngine(): LlamaServiceTestAccess {
  const access = prepareFakeEngine()
  access.currentModel = LOADED_MODEL
  access.session = {
    promptWithMeta: vi.fn(() =>
      Promise.resolve({ response: [], responseText: 'still working', stopReason: 'eogToken' })
    ),
    dispose: vi.fn(),
    chatWrapper: fakeChatWrapper,
    getChatHistory: () => [{ type: 'system', text: 'Test system prompt.' }]
  }
  vi.spyOn(access, 'getModule').mockResolvedValue({
    readGgufFileInfo: () => Promise.reject(new Error('not a real gguf'))
  })
  return access
}

function loadOversized(): Promise<unknown> {
  return llamaService.loadModel({ path: OVERSIZED_MODEL.path, contextSize: 8_192 }, OVERSIZED_MODEL)
}

describe('LlamaService refused load', () => {
  it('leaves the previous model loaded and usable when a load is refused', async () => {
    prepareLoadedEngine()

    await expect(loadOversized()).rejects.toThrow(/only .* GB of RAM is free/)

    // The refusal happens before anything is unloaded, so claiming the engine
    // is in error — with the refused model's info, no less — was doubly wrong:
    // it named a model that was never loaded, and `generateInternal` gates on
    // `status === 'ready'`, so it cost the user a working session.
    const state = llamaService.getState()
    expect(state.status).toBe('ready')
    expect(state.model).toBe(LOADED_MODEL)
    expect(state.error).toBeUndefined()

    const outcome = (await generateOnce()) as { content: string }
    expect(outcome.content).toBe('still working')
  })

  it('records the refusal separately, naming the model that did not load', async () => {
    prepareLoadedEngine()

    await expect(loadOversized()).rejects.toThrow()

    const refused = llamaService.getState().refusedLoad
    expect(refused?.model).toBe(OVERSIZED_MODEL)
    expect(refused?.reason).toContain(OVERSIZED_MODEL.name)
  })

  it('clears the refusal on dismissal and on unload', async () => {
    prepareLoadedEngine()
    await expect(loadOversized()).rejects.toThrow()
    expect(llamaService.getState().refusedLoad).toBeDefined()

    llamaService.dismissRefusedLoad()
    expect(llamaService.getState().refusedLoad).toBeUndefined()

    // And again via unload — a notice saying "your engine is untouched" must
    // not outlive the engine it was describing.
    await expect(loadOversized()).rejects.toThrow()
    expect(llamaService.getState().refusedLoad).toBeDefined()
    await llamaService.unload()
    expect(llamaService.getState().refusedLoad).toBeUndefined()
  })
})

describe('LlamaService native backend', () => {
  it('initialises exactly one backend under concurrent callers', async () => {
    const access = prepareFakeEngine()
    const backend = { id: 'backend' }
    // Resolves on a later tick so both callers are genuinely in flight at once
    // — the whole point of the race.
    const getLlama = vi.fn(() => new Promise((resolve) => setTimeout(() => resolve(backend), 5)))
    vi.spyOn(access, 'getModule').mockResolvedValue({ getLlama })

    const [first, second] = await Promise.all([
      llamaService.getLlamaBackend(),
      llamaService.getLlamaBackend()
    ])

    // A second native backend for the same process is the documented hazard
    // this method exists to prevent; `EmbeddingService` calls it in the
    // background while a model load may be running.
    expect(getLlama).toHaveBeenCalledTimes(1)
    expect(first).toBe(backend)
    expect(second).toBe(backend)
  })

  it('retries after a failed backend initialisation', async () => {
    const access = prepareFakeEngine()
    const backend = { id: 'backend' }
    const getLlama = vi
      .fn()
      .mockRejectedValueOnce(new Error('no GPU'))
      .mockResolvedValueOnce(backend)
    vi.spyOn(access, 'getModule').mockResolvedValue({ getLlama })

    // Regression guard for the memoisation added above: caching the promise
    // must not cache a rejection for the lifetime of the process.
    await expect(llamaService.getLlamaBackend()).rejects.toThrow('no GPU')
    await expect(llamaService.getLlamaBackend()).resolves.toBe(backend)
    expect(getLlama).toHaveBeenCalledTimes(2)
  })
})
