import { createHash } from 'node:crypto'
import { readdirSync, statSync, existsSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import type { ModelInfo } from '@shared/model.types'
import { settingsStore } from '../settings/SettingsStore'
import { createLogger } from '../utils/logger'

const log = createLogger('scanner')

const GGUF_EXTENSION = '.gguf'
// Common llama.cpp quantization tags, matched to label a model in the UI.
const QUANT_PATTERN = /\b(Q\d(?:_[A-Z0-9]+)*|F16|F32|BF16|IQ\d[A-Z0-9_]*)\b/i

/**
 * Discover all local models: every `.gguf` file in the configured models
 * directory plus any individually added file paths. Results are de-duplicated
 * by absolute path and sorted by name.
 */
export function scanModels(): ModelInfo[] {
  const settings = settingsStore.get()
  const found = new Map<string, ModelInfo>()

  for (const path of listGgufFiles(settings.modelsDirectory).filter(
    (candidate) => !isVisionProjectorFileName(candidate)
  )) {
    const info = describeModel(path)
    if (info) found.set(info.path, info)
  }

  for (const path of settings.addedModelPaths) {
    if (found.has(path) || isVisionProjectorFileName(path)) continue
    const info = describeModel(path)
    if (info) found.set(info.path, info)
  }

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function listGgufFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === GGUF_EXTENSION)
      .map((entry) => join(dir, entry.name))
  } catch (error) {
    log.warn('Failed to read models directory', dir, error)
    return []
  }
}

/** Build a {@link ModelInfo} for a single file, or `null` if it is unreadable. */
export function describeModel(path: string): ModelInfo | null {
  try {
    if (isVisionProjectorFileName(path)) return null
    const stats = statSync(path)
    if (!stats.isFile()) return null
    const fileName = basename(path)
    const visionProjectorPath = resolveVisionProjectorPath(path)
    const visionProjectorSizeBytes = visionProjectorPath
      ? statSync(visionProjectorPath).size
      : undefined
    return {
      id: hashPath(path),
      name: prettifyName(fileName),
      path,
      sizeBytes: stats.size,
      quant: QUANT_PATTERN.exec(fileName)?.[0]?.toUpperCase(),
      visionProjectorPath,
      visionProjectorSizeBytes,
      source: 'local'
    }
  } catch (error) {
    log.warn('Failed to describe model', path, error)
    return null
  }
}

/** Projector GGUFs are model components, not standalone chat models. */
export function isVisionProjectorFileName(path: string): boolean {
  const name = basename(path).toLowerCase()
  return (
    name.endsWith('.gguf') &&
    (name.includes('mmproj') ||
      name.includes('vision-projector') ||
      name.includes('vision_projector') ||
      name.startsWith('clip-model'))
  )
}

function resolveVisionProjectorPath(modelPath: string): string | undefined {
  const configured = settingsStore.get().visionProjectorPaths[modelPath]
  if (
    configured &&
    existsSync(configured) &&
    statSync(configured).isFile() &&
    isVisionProjectorFileName(configured)
  ) {
    return configured
  }

  try {
    const candidates = listGgufFiles(dirname(modelPath)).filter(isVisionProjectorFileName)
    if (candidates.length === 1) return candidates[0]
  } catch {
    // A manually-added model can live in an unreadable directory. It remains
    // a valid text model even when companion discovery is unavailable.
  }
  return undefined
}

function hashPath(path: string): string {
  return createHash('sha1').update(path).digest('hex').slice(0, 12)
}

function prettifyName(fileName: string): string {
  return fileName.replace(new RegExp(`${GGUF_EXTENSION}$`, 'i'), '')
}
