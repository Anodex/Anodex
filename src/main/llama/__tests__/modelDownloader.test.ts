import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecommendedModel } from '@shared/recommendedModels'
import { recommendedModelFileName } from '@shared/recommendedModels'
import { cancelDownload, downloadModel } from '../modelDownloader'

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
    const path = await downloadModel(MODEL, dir, (p) => progress.push(p.status))

    expect(path).toBe(join(dir, recommendedModelFileName(MODEL)))
    expect(await readFile(path, 'utf-8')).toBe('hello world')
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
    const path = await downloadModel(MODEL, dir, (p) => progress.push(p.status))

    expect(path).toBe(existingPath)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(progress).toEqual(['done'])
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

  it('rejects and cleans up when canceled mid-download', async () => {
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
})
