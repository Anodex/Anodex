import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RecommendedModel } from '@shared/recommendedModels'

let userDataDir = ''

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir }
}))

const { recallTopModels, rememberTopModels } = await import('../topModelsCache')

const MODEL = {
  id: 'hf:unsloth/Test-GGUF:test.gguf',
  name: 'Test',
  family: 'qwen',
  tier: '14b',
  description: 'test',
  approxSize: '15.3 GB',
  minRam: '22 GB',
  minRamGb: 22,
  idealRamGb: 27,
  downloadUrl: 'https://example.invalid/test.gguf',
  tags: [],
  primaryUse: 'general',
  source: 'huggingface',
  publishedAt: '2026-08-13',
  recommended: true
} as RecommendedModel

beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'anodex-top-models-'))
})

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true })
})

describe('topModelsCache', () => {
  it('has nothing to serve before a fetch has ever succeeded', async () => {
    expect(await recallTopModels()).toBeNull()
  })

  it('serves the last list that arrived', async () => {
    await rememberTopModels([MODEL])
    const recalled = await recallTopModels()
    expect(recalled).toHaveLength(1)
    expect(recalled?.[0].id).toBe(MODEL.id)
  })

  it('does not remember an empty result as if it were an answer', async () => {
    // An empty fetch is a failure wearing a success's clothes; caching it
    // would serve nothing for as long as the file survived.
    await rememberTopModels([])
    expect(await recallTopModels()).toBeNull()
  })

  it('ignores a cache written on a different scale', async () => {
    // Every cached entry carries the `minRamGb` its own build computed. When
    // that formula changes, an old cache ranks unfairly against today's
    // curated figures, so the format version drops it.
    writeFileSync(
      join(userDataDir, 'top-models.json'),
      JSON.stringify({ format: 0, at: Date.now(), models: [MODEL] })
    )
    expect(await recallTopModels()).toBeNull()
  })

  it('ignores a damaged file rather than throwing', async () => {
    writeFileSync(join(userDataDir, 'top-models.json'), '{ not json')
    expect(await recallTopModels()).toBeNull()
  })

  it('survives a write it cannot make', async () => {
    userDataDir = join(userDataDir, 'does', 'not', 'exist')
    await expect(rememberTopModels([MODEL])).resolves.toBeUndefined()
  })
})
