import { createHash } from 'node:crypto'
import { readdirSync, statSync, existsSync } from 'node:fs'
import { basename, dirname, extname, join, parse } from 'node:path'
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

/**
 * Drop `addedModelPaths` entries whose file is gone for good. A stale entry is
 * otherwise permanent: `describeModel` returns `null` for it, so it never
 * appears in the models list, and the only removal path (`models:delete`) is
 * reached from that list — meanwhile every scan warns about it again.
 *
 * An entry is only dropped when its own drive root is reachable, which is what
 * separates a deleted file from a temporarily unavailable one: an unplugged
 * `E:\` or an offline `\\server\share` fails the root check and keeps all of
 * its models. A relative path (which the file picker never produces) parses to
 * an empty root and is likewise kept, so an unexpected shape is never data loss.
 *
 * Called once at startup rather than from {@link scanModels}, which stays a
 * pure read that any subsystem can call at any time without writing settings.
 */
export function pruneMissingModelPaths(): void {
  const { addedModelPaths } = settingsStore.get()
  const live = addedModelPaths.filter((path) => existsSync(path) || !existsSync(parse(path).root))
  if (live.length === addedModelPaths.length) return

  const dropped = addedModelPaths.filter((path) => !live.includes(path))
  log.info('Dropping model paths that no longer exist:', dropped.join(', '))
  settingsStore.update({ addedModelPaths: live })
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
    if (named.length > 1) return closestNamedProjector(named, modelPath)

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
 * Break a tie between projectors that all name this model, by preferring the
 * one that says nothing the model's own name does not.
 *
 * Refusing outright whenever more than one matched cost a user their vision
 * model. `Qwen3.6-27B-Q4_K_M` reduces to `qwen3 6 27b`; so does its own
 * `Qwen3.6-27B-GGUF-mmproj-F16`, and so — as a prefix — does an unrelated
 * `Qwen3.6-27B-Fable-Fusion-711-…-mmproj-F16` belonging to a *different*
 * finetune in the same folder. Installing that second vision model silently
 * downgraded the first to a text model, with no message and no way to tell why
 * `inspect_visual` had stopped existing.
 *
 * The tie-break keeps the safety property that made this strict in the first
 * place. It scores each candidate by how far its identifying words are from the
 * model's own — counting both the words it adds and the words it lacks — and
 * takes the nearest. Extra words (`fable`, `fusion`, `711`) mean the projector
 * claims a *more* specific model than this one; missing words mean it claims a
 * broader family. Neither is as good as naming exactly this model, and scoring
 * both directions is what lets the plain model and the finetune each keep their
 * own projector out of the same folder. Only a unique best is accepted — a
 * genuine tie still declines, because two equally specific claims are exactly
 * the case where guessing pairs the wrong backend.
 */
function closestNamedProjector(candidates: string[], modelPath: string): string | undefined {
  const modelTokens = new Set(identifyingTokens(basename(modelPath)))
  const distances = candidates.map((candidate) => {
    const tokens = identifyingTokens(basename(candidate))
    const added = tokens.filter((token) => !modelTokens.has(token)).length
    const seen = new Set(tokens)
    const missing = [...modelTokens].filter((token) => !seen.has(token)).length
    return added + missing
  })
  const nearest = Math.min(...distances)
  return distances.filter((distance) => distance === nearest).length === 1
    ? candidates[distances.indexOf(nearest)]
    : undefined
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

/**
 * Words that describe how a GGUF was quantized rather than which model it is.
 *
 * `ud` is Unsloth's dynamic-quant marker. It sits in the model's file name and
 * not in its projector's, which was enough to stop `Muse-Glimmer-30B-UD-Q5_K_M`
 * ever finding `Muse-Glimmer-30B-GGUF-mmproj-…` — the two names agree on every
 * word that identifies the model and disagree only on the quantization recipe.
 */
function isQuantToken(token: string): boolean {
  return /^(q\d[a-z0-9]*|f16|f32|bf16|iq\d[a-z0-9]*|ud|k|s|m|l|xs|xl)$/.test(token)
}

function hashPath(path: string): string {
  return createHash('sha1').update(path).digest('hex').slice(0, 12)
}

function prettifyName(fileName: string): string {
  return fileName.replace(new RegExp(`${GGUF_EXTENSION}$`, 'i'), '')
}
