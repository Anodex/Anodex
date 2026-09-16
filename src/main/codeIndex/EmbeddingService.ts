import { app } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { LlamaModel, LlamaEmbeddingContext } from 'node-llama-cpp'
import { llamaService } from '../llama/LlamaService'
import { createLogger } from '../utils/logger'

const log = createLogger('embedding-service')

/**
 * Bundled with Anodex itself (see `electron-builder.yml`'s `extraResources`
 * and `resources/embedding-model/`) — deliberately NOT downloaded at runtime.
 * A small, dedicated text-embedding model, distinct from whatever chat model
 * the user has loaded: it has no conversational role, it only turns text
 * into vectors so similar chunks can be matched (see `search_code`).
 */
const EMBEDDING_MODEL_FILENAME = 'nomic-embed-text-v1.5.Q4_K_M.gguf'

/** Where the bundled embedding model actually lives — differs between a dev run and a packaged build. */
function resolveModelPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'embedding-model', EMBEDDING_MODEL_FILENAME)
    : join(app.getAppPath(), 'resources', 'embedding-model', EMBEDDING_MODEL_FILENAME)
}

/**
 * Owns the small embedding model's own lifecycle, entirely separate from the
 * user's chat model in `LlamaService` — loading, unloading, or even crashing
 * the chat model must never affect this, and vice versa. Shares the same
 * native `Llama` backend handle (`llamaService.getLlamaBackend()`) rather
 * than initializing a second one, since this project's own history has
 * multiple documented native-crash incidents tied to GPU backend init.
 *
 * Always loaded CPU-only (`gpuLayers: 0`), deliberately: the model is tiny
 * (~80 MB, 137M params) so CPU inference is fast enough for a code chunk,
 * and this avoids contending for VRAM with — or risking any GPU-backend
 * interaction with — the much larger chat model that may already be loaded.
 */
/**
 * How long the model stays loaded after the last piece of text it embedded.
 *
 * It loads on the first code search and used to stay for the life of the app, whether
 * or not anything searched code again — measured on the user's machine, the main
 * process sat at 854MB with nothing saying what was in it. Ten minutes keeps it for a
 * session of searching, and lets it go for the rest of the day. Reloading costs about
 * a second on the next search.
 */
const IDLE_RELEASE_MS = 10 * 60_000

class EmbeddingService {
  private model?: LlamaModel
  private context?: LlamaEmbeddingContext
  private loadPromise: Promise<void> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  /** Whether the bundled model file is actually present on disk. */
  isAvailable(): boolean {
    return existsSync(resolveModelPath())
  }

  /** The embedding vector's dimensionality — only valid after `embed()` has succeeded at least once. */
  getVectorSize(): number | undefined {
    return this.model?.embeddingVectorSize
  }

  /**
   * Embed a single piece of text. Loads the model on first call (memoized —
   * concurrent callers await the same in-flight load rather than racing to
   * load twice) and reuses it for every call after.
   */
  async embed(text: string): Promise<number[]> {
    await this.ensureLoaded()
    if (!this.context) throw new Error('Embedding model failed to load.')
    try {
      const embedding = await this.context.getEmbeddingFor(text)
      return [...embedding.vector]
    } finally {
      this.holdWhileInUse()
    }
  }

  /** Whether the model is in memory right now. For the memory report. */
  isLoaded(): boolean {
    return this.context !== undefined
  }

  /**
   * Let the model go now. Called on quit and by the idle timer; the next `embed`
   * loads it again.
   */
  async release(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    if (!this.context && !this.model) return
    this.loadPromise = null
    await this.disposeModel()
    log.info('Embedding model let go after a spell with no code search')
  }

  /** Restart the idle countdown; indexing a project keeps it loaded throughout. */
  private holdWhileInUse(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      void this.release()
    }, IDLE_RELEASE_MS)
    // A pending timer must not hold a quitting app open.
    this.idleTimer.unref?.()
  }

  private async ensureLoaded(): Promise<void> {
    if (this.context) return
    this.loadPromise ??= this.load()
    await this.loadPromise
  }

  private async load(): Promise<void> {
    const modelPath = resolveModelPath()
    if (!existsSync(modelPath)) {
      throw new Error(
        `Embedding model not found at ${modelPath}. It should be bundled with Anodex — ` +
          'this likely means a dev checkout without resources/embedding-model/ populated.'
      )
    }

    try {
      const llama = await llamaService.getLlamaBackend()
      this.model = await llama.loadModel({ modelPath, gpuLayers: 0 })
      this.context = await this.model.createEmbeddingContext()
      log.info('Embedding model ready', {
        vectorSize: this.model.embeddingVectorSize
      })
    } catch (error) {
      this.loadPromise = null
      await this.disposeModel()
      log.error('Failed to load embedding model:', error)
      throw error
    }
  }

  private async disposeModel(): Promise<void> {
    try {
      await this.context?.dispose()
    } catch {
      // Best-effort — nothing meaningful to recover if disposal itself fails.
    }
    this.context = undefined
    this.model = undefined
  }
}

export const embeddingService = new EmbeddingService()
