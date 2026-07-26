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
    const siblings = listGgufFiles(dirname(modelPath))
    const projectors = siblings.filter(isVisionProjectorFileName)
    const named = projectors.filter((candidate) => namesTheSameModel(candidate, modelPath))
    if (named.length === 1) return named[0]
    if (named.length > 1) return undefined

    // A projector named only for its role (`mmproj-model-f16.gguf`) says
    // nothing about which model it serves. Trust it only where there is
    // nothing else it could belong to.
    const unnamed = projectors.filter(
      (candidate) => identifyingTokens(basename(candidate)).length === 0
    )
    const models = siblings.filter((candidate) => !isVisionProjectorFileName(candidate))
    if (unnamed.length === 1 && models.length === 1) return unnamed[0]
  } catch {
    // A manually-added model can live in an unreadable directory. It remains
    // a valid text model even when companion discovery is unavailable.
  }
  return undefined
}

/**
 * Decide whether two file names claim the same model. Pairing a projector to
 * the wrong model is not cosmetic — it switches the whole backend to
 * llama-server and changes tokenization, tool calling and thinking behaviour —
 * so the names have to vouch for the pair before it is made automatically.
 *
 * The test is that one name's identifying words appear whole inside the
 * other's, which tolerates the vendor and repository prefixes projectors
 * collect (`mmproj-google_gemma-3-27b-it-f16` still matches
 * `gemma-3-27b-it-Q4_K_M`) while keeping `Qwen3.5-27B-…` and `Qwen3-8B-…`
 * away from a `Qwen3.6-27B` projector. A single shared word is too thin to
 * act on unless it is all either name has.
 */
function namesTheSameModel(projectorPath: string, modelPath: string): boolean {
  const projectorTokens = identifyingTokens(basename(projectorPath))
  const modelTokens = identifyingTokens(basename(modelPath))
  const [shorter, longer] =
    projectorTokens.length <= modelTokens.length
      ? [projectorTokens, modelTokens]
      : [modelTokens, projectorTokens]
  if (shorter.length === 0) return false
  if (shorter.length === 1 && longer.length > 1) return false

  return longer.some(
    (_token, start) =>
      start + shorter.length <= longer.length &&
      shorter.every((token, offset) => token === longer[start + offset])
  )
}

// Words that describe a file's role or format rather than which model it is.
const GENERIC_NAME_TOKENS = new Set([
  'gguf',
  'mmproj',
  'proj',
  'projector',
  'vision',
  'clip',
  'model',
  'instruct',
  'chat',
  'it'
])

/**
 * Reduce a GGUF file name to the lowercase words that identify its model,
 * dropping quantization tags and role words so that `Qwen3.6-27B-Q4_K_M` and
 * `Qwen3.6-27B-GGUF-mmproj-F16` agree on `['qwen3', '6', '27b']`.
 */
function identifyingTokens(fileName: string): string[] {
  return prettifyName(fileName)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0 && !GENERIC_NAME_TOKENS.has(token) && !isQuantToken(token))
}

function isQuantToken(token: string): boolean {
  return /^(q\d[a-z0-9]*|f16|f32|bf16|iq\d[a-z0-9]*|k|s|m|l|xs|xl)$/.test(token)
}

function hashPath(path: string): string {
  return createHash('sha1').update(path).digest('hex').slice(0, 12)
}

function prettifyName(fileName: string): string {
  return fileName.replace(new RegExp(`${GGUF_EXTENSION}$`, 'i'), '')
}
