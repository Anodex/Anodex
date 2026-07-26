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

  it('keeps an mmproj out of the model list and pairs a lone sibling automatically', async () => {
    const modelPath = join(dir, 'Qwen3.6-Q4_K_M.gguf')
    const projectorPath = join(dir, 'mmproj-F16.gguf')
    await writeFile(modelPath, 'model')
    await writeFile(projectorPath, 'projector')

    const models = scanModels()

    expect(models).toHaveLength(1)
    expect(models[0]?.path).toBe(modelPath)
    expect(models[0]?.visionProjectorPath).toBe(projectorPath)
  })

  it('pairs a projector only with the model whose name it shares', async () => {
    const visionPath = join(dir, 'Qwen3.6-27B-Q4_K_M.gguf')
    const projectorPath = join(dir, 'Qwen3.6-27B-GGUF-mmproj-F16.gguf')
    const textOnly = [
      'Llama-3.2-3B-Instruct-Q4_K_M.gguf',
      'Qwen2.5-Coder-14B-Instruct-q4_k_m.gguf',
      'Qwen3-8B-GGUF-Qwen3-8B-Q4_K_M.gguf',
      'Qwen3.5-27B-Reasoning-Distilled-GGUF-Qwen3.5-27B.Q4_K_M.gguf',
      'gemma4-coding-Q8_0.gguf'
    ].map((name) => join(dir, name))
    await Promise.all(
      [visionPath, projectorPath, ...textOnly].map((path) => writeFile(path, 'gguf'))
    )

    const paired = new Map(scanModels().map((model) => [model.path, model.visionProjectorPath]))

    expect(paired.get(visionPath)).toBe(projectorPath)
    for (const path of textOnly) expect(paired.get(path)).toBeUndefined()
  })

  it('pairs a differently quantized build of the same model', async () => {
    const modelPath = join(dir, 'Qwen3.6-27B-UD-Q8_K_XL.gguf')
    const projectorPath = join(dir, 'Qwen3.6-27B-GGUF-mmproj-F16.gguf')
    await Promise.all([writeFile(modelPath, 'model'), writeFile(projectorPath, 'projector')])

    expect(describeModel(modelPath)?.visionProjectorPath).toBe(projectorPath)
  })

  it('sees through the vendor prefix projectors collect', async () => {
    const modelPath = join(dir, 'gemma-3-27b-it-Q4_K_M.gguf')
    const projectorPath = join(dir, 'mmproj-google_gemma-3-27b-it-f16.gguf')
    const otherPath = join(dir, 'Llama-3.2-3B-Instruct-Q4_K_M.gguf')
    await Promise.all([modelPath, projectorPath, otherPath].map((path) => writeFile(path, 'gguf')))

    expect(describeModel(modelPath)?.visionProjectorPath).toBe(projectorPath)
    expect(describeModel(otherPath)?.visionProjectorPath).toBeUndefined()
  })

  it('refuses to pair on a single shared word', async () => {
    const modelPath = join(dir, 'Qwen3-Q4_K_M.gguf')
    const projectorPath = join(dir, 'Qwen3.6-27B-GGUF-mmproj-F16.gguf')
    const otherPath = join(dir, 'Llama-3.2-3B-Instruct-Q4_K_M.gguf')
    await Promise.all([modelPath, projectorPath, otherPath].map((path) => writeFile(path, 'gguf')))

    expect(describeModel(modelPath)?.visionProjectorPath).toBeUndefined()
  })

  it('leaves a role-named projector unpaired when several models could claim it', async () => {
    const projectorPath = join(dir, 'mmproj-model-f16.gguf')
    const llamaPath = join(dir, 'Llama-3.2-3B-Instruct-Q4_K_M.gguf')
    const qwenPath = join(dir, 'Qwen3.6-27B-Q4_K_M.gguf')
    await Promise.all([projectorPath, llamaPath, qwenPath].map((path) => writeFile(path, 'gguf')))

    expect(describeModel(llamaPath)?.visionProjectorPath).toBeUndefined()
    expect(describeModel(qwenPath)?.visionProjectorPath).toBeUndefined()
  })

  it('honours an explicit override that no naming rule would infer', async () => {
    const modelPath = join(dir, 'Llama-3.2-3B-Instruct-Q4_K_M.gguf')
    const projectorPath = join(dir, 'Qwen3.6-27B-GGUF-mmproj-F16.gguf')
    const otherPath = join(dir, 'Qwen3.6-27B-Q4_K_M.gguf')
    await Promise.all([modelPath, projectorPath, otherPath].map((path) => writeFile(path, 'gguf')))
    mockSettings.visionProjectorPaths = { [modelPath]: projectorPath }

    expect(describeModel(modelPath)?.visionProjectorPath).toBe(projectorPath)
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
