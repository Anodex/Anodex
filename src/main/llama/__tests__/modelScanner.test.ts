import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockSettings = vi.hoisted(() => ({
  modelsDirectory: '',
  addedModelPaths: [] as string[],
  visionProjectorPaths: {}
}))

vi.mock('../../settings/SettingsStore', () => ({
  settingsStore: {
    get: () => mockSettings
  }
}))

import { describeModel, scanModels } from '../modelScanner'

describe('modelScanner vision projectors', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anodex-model-scan-'))
    mockSettings.modelsDirectory = dir
    mockSettings.addedModelPaths = []
    mockSettings.visionProjectorPaths = {}
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('keeps an mmproj out of the model list and pairs a sole sibling automatically', async () => {
    const modelPath = join(dir, 'Qwen3.6-Q4_K_M.gguf')
    const projectorPath = join(dir, 'mmproj-F16.gguf')
    await writeFile(modelPath, 'model')
    await writeFile(projectorPath, 'projector')

    const models = scanModels()

    expect(models).toHaveLength(1)
    expect(models[0]?.path).toBe(modelPath)
    expect(models[0]?.visionProjectorPath).toBe(projectorPath)
  })

  it('uses the explicitly selected projector when several siblings exist', async () => {
    const modelPath = join(dir, 'Qwen3.6-Q4_K_M.gguf')
    const f16Path = join(dir, 'mmproj-F16.gguf')
    const q8Path = join(dir, 'mmproj-Q8_0.gguf')
    await Promise.all([
      writeFile(modelPath, 'model'),
      writeFile(f16Path, 'f16'),
      writeFile(q8Path, 'q8')
    ])
    mockSettings.visionProjectorPaths = { [modelPath]: q8Path }

    expect(describeModel(modelPath)?.visionProjectorPath).toBe(q8Path)
  })
})
