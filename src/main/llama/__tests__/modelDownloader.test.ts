import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecommendedModel } from '@shared/recommendedModels'
import {
  recommendedModelFileName,
  recommendedVisionProjectorFileName
} from '@shared/recommendedModels'
import {
  cancelDownload,
  discardPartialDownload,
  downloadModel,
  partialDownloadBytes
} from '../modelDownloader'

const MODEL: RecommendedModel = {
  id: 'test-model',
  name: 'Test Model',
  family: 'other',
  tier: '3b',
  description: 'A model used only in tests.',
  approxSize: '11 B',
  minRam: '8 GB',
  minRamGb: 8,
  downloadUrl: 'https://example.com/models/resolve/main/test-model-q4_k_m.gguf',
  tags: []
}

function bodyStream(text: string): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    }
  })
}

describe('downloadModel', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anodex-download-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
    vi.unstubAllGlobals()
  })

  it('downloads the body to the expected filename and reports progress', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-length', '11']]),
      body: bodyStream('hello world')
    })

    const progress: string[] = []
    const downloaded = await downloadModel(MODEL, dir, (p) => progress.push(p.status))

    expect(downloaded.modelPath).toBe(join(dir, recommendedModelFileName(MODEL)))
    expect(await readFile(downloaded.modelPath, 'utf-8')).toBe('hello world')
    expect(progress.at(-1)).toBe('done')
    expect(progress).toContain('downloading')
    // No leftover .part file.
    expect(await readdir(dir)).toEqual([recommendedModelFileName(MODEL)])
  })

  it('skips the network and resolves immediately when the file already exists', async () => {
    const existingPath = join(dir, recommendedModelFileName(MODEL))
    await writeFile(existingPath, 'already here')
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy

    const progress: string[] = []
    const downloaded = await downloadModel(MODEL, dir, (p) => progress.push(p.status))

    expect(downloaded.modelPath).toBe(existingPath)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(progress).toEqual(['done'])
  })

  it('downloads a vision projector beside the model and returns both paths', async () => {
    const visionModel: RecommendedModel = {
      ...MODEL,
      id: 'test-vision-model',
      visionProjectorUrl: 'https://example.com/models/resolve/main/mmproj-F16.gguf',
      visionProjectorFileName: 'test-model-mmproj-F16.gguf'
    }
    globalThis.fetch = vi.fn().mockImplementation((url: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: new Map([['content-length', url.includes('mmproj') ? '9' : '11']]),
        body: bodyStream(url.includes('mmproj') ? 'projector' : 'hello world')
      })
    )

    const downloaded = await downloadModel(visionModel, dir, () => {})
    const projectorName = recommendedVisionProjectorFileName(visionModel)
    expect(projectorName).not.toBeNull()
    expect(downloaded.modelPath).toBe(join(dir, recommendedModelFileName(visionModel)))
    expect(downloaded.visionProjectorPath).toBe(join(dir, projectorName!))
    expect(await readFile(downloaded.modelPath, 'utf-8')).toBe('hello world')
    expect(await readFile(downloaded.visionProjectorPath!, 'utf-8')).toBe('projector')
  })

  it('counts the projector still to come in the total while the model downloads', async () => {
    const visionModel: RecommendedModel = {
      ...MODEL,
      id: 'test-vision-total',
      visionProjectorUrl: 'https://example.com/models/resolve/main/mmproj-F16.gguf',
      visionProjectorFileName: 'test-model-mmproj-F16.gguf',
      visionProjectorBytes: 9
    }
    globalThis.fetch = vi.fn().mockImplementation((url: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: new Map([['content-length', url.includes('mmproj') ? '9' : '11']]),
        body: bodyStream(url.includes('mmproj') ? 'projector' : 'hello world')
      })
    )

    const totals: Array<number | null> = []
    await downloadModel(visionModel, dir, (p) => {
      if (p.status === 'downloading') totals.push(p.totalBytes)
    })

    expect(totals.length).toBeGreaterThan(0)
    expect(new Set(totals)).toEqual(new Set([20]))
  })

  // Hundreds of reports a second kept the window too busy to answer Cancel.
  it('reports progress a few times a second, not once per network chunk', async () => {
    const chunks = 200
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-length', String(chunks)]]),
      body: new ReadableStream({
        start(controller) {
          for (let i = 0; i < chunks; i++) controller.enqueue(new Uint8Array([i % 256]))
          controller.close()
        }
      })
    })

    const statuses: string[] = []
    await downloadModel({ ...MODEL, id: 'throttled' }, dir, (p) => statuses.push(p.status))

    expect(statuses.filter((s) => s === 'downloading').length).toBeLessThan(5)
    expect(statuses.at(-1)).toBe('done')
  })

  it('rejects and cleans up on a non-OK response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Map(),
      body: null
    })

    await expect(downloadModel(MODEL, dir, () => {})).rejects.toThrow('404')
    expect(await readdir(dir)).toEqual([])
  })

  it('rejects and reports canceled when stopped before any bytes arrive', async () => {
    globalThis.fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new DOMException('Aborted', 'AbortError'))
          return
        }
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'))
        })
      })
    })

    const progress: string[] = []
    const promise = downloadModel(MODEL, dir, (p) => progress.push(p.status))
    cancelDownload(MODEL.id)

    await expect(promise).rejects.toThrow()
    expect(progress.at(-1)).toBe('canceled')
    expect(await readdir(dir)).toEqual([])
  })

  describe('partial downloads', () => {
    const modelFile = (): string => join(dir, recommendedModelFileName(MODEL))

    it('reports the bytes a resume would start from, and only resumable ones', async () => {
      expect(partialDownloadBytes(MODEL, dir)).toBe(0)

      await writeFile(`${modelFile()}.part`, 'PARTIAL')
      // No validator beside it means the next attempt starts over, so it is
      // not offered as progress.
      expect(partialDownloadBytes(MODEL, dir)).toBe(0)

      await writeFile(`${modelFile()}.part.etag`, '"v1"')
      expect(partialDownloadBytes(MODEL, dir)).toBe(7)
    })

    it('reports nothing for a model that is already installed', async () => {
      await writeFile(modelFile(), 'WHOLE MODEL')
      expect(partialDownloadBytes(MODEL, dir)).toBe(0)
    })

    it('counts a finished model toward a projector still to come', async () => {
      const vision: RecommendedModel = {
        ...MODEL,
        id: 'vision-model',
        visionProjectorUrl: 'https://example.com/models/resolve/main/mmproj-test-f16.gguf'
      }
      const projector = join(dir, recommendedVisionProjectorFileName(vision)!)
      await writeFile(join(dir, recommendedModelFileName(vision)), 'MODEL')
      expect(partialDownloadBytes(vision, dir)).toBe(0)

      await writeFile(`${projector}.part`, 'PRO')
      await writeFile(`${projector}.part.etag`, '"v1"')
      expect(partialDownloadBytes(vision, dir)).toBe(8)
    })

    it('discards the part and its validator, and nothing else', async () => {
      await writeFile(`${modelFile()}.part`, 'PARTIAL')
      await writeFile(`${modelFile()}.part.etag`, '"v1"')
      await writeFile(join(dir, 'other.gguf'), 'SOMEONE ELSE')

      await discardPartialDownload(MODEL, dir)

      expect(await readdir(dir)).toEqual(['other.gguf'])
      expect(partialDownloadBytes(MODEL, dir)).toBe(0)
    })
  })
})
