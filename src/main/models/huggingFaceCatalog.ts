import type { RecommendedModel, ModelTier } from '@shared/recommendedModels'
import { inferModelFamily } from '@shared/recommendedModels'
import { ok, err, toErrorMessage, type Result } from '@shared/result'
import { createLogger } from '../utils/logger'

const log = createLogger('hf-catalog')

const SEARCH_TIMEOUT_MS = 10_000
const DETAIL_TIMEOUT_MS = 10_000
/** How many search hits to fetch full details for — bounds how many extra
 *  requests one search fans out into (Hugging Face's search endpoint doesn't
 *  return file listings itself). */
const MAX_DETAILED_RESULTS = 8

/**
 * Publishers/quantizers trusted enough to seed "Recommended for your PC"
 * without a human vetting each individual model release. Deliberately a list
 * of orgs, not model names/versions — orgs change rarely, so this doesn't
 * need updating every time a new model generation ships, which is the whole
 * point of sourcing recommendations live instead of hand-listing them.
 * Chosen because a global "sort by downloads" browse surfaces plenty of noise
 * (embedding models, novelty/uncensored fine-tunes) that has no business
 * being a default "Best Overall" pick for a coding assistant.
 */
const TRUSTED_PUBLISHERS = [
  'Qwen',
  'meta-llama',
  'mistralai',
  'deepseek-ai',
  'google',
  'microsoft',
  'bartowski',
  'unsloth'
]
/** Per-publisher, per-query result cap — kept small since this fans out across ~8 publishers × 2 queries. */
const MAX_PER_PUBLISHER = 6
/** Total live candidates handed back to the "Recommended" scorer, after merging every publisher's results. */
const MAX_TOP_MODELS = 24
/**
 * A plain "sort by downloads" browse is dominated by whatever gets pulled by
 * the most different consumers overall — small base/embedding models used in
 * countless unrelated pipelines outdownload a purpose-built coding model many
 * times over (confirmed live: Qwen's own top-downloaded GGUF repos were a 4B
 * base chat model and a 1.5B instruct model, not any Coder variant — a
 * Coder-scoped query was needed to surface `Qwen3-Coder-Next-GGUF` at all).
 * Running one coding-scoped query alongside the general browse, per
 * publisher, is what actually lets a new coding-model generation surface
 * without hardcoding its name — the fix is a generic search term, not a
 * version number, so it doesn't need updating either.
 */
const CODING_SEARCH_TERM = 'coder'

/**
 * How a repository is asked for. A downloads sort alone answers "what has been
 * fetched most since it existed", which is a question about the past: measured
 * live, every publisher's top GGUF repos were between one and two years old,
 * and the model this machine actually runs did not appear at all. Asking each
 * publisher what is new and what is being taken up now is what puts a current
 * generation in front of somebody opening Anodex for the first time.
 */
const SORTS = ['downloads', 'trendingScore', 'createdAt'] as const

/**
 * A repository needs this many downloads before its rate means anything.
 *
 * Rate is downloads over days, so a repository published this morning divides by
 * one — without a floor, anything uploaded overnight outranks a model the world
 * is actually using.
 */
const MIN_DOWNLOADS_TO_RANK = 2_000

/** A day, for reading an age in days off two timestamps. */
const DAY_MS = 86_400_000

/**
 * How fast a model is being taken up: downloads per day since it was published.
 *
 * Total downloads is a measure of age as much as of worth — on the day this was
 * written, a July 2025 release led every publisher's list with 12.8M downloads
 * while the August 2026 model that had already been fetched 9.4M times in its
 * first month sat below it, and the generation in between sat above them both on
 * nothing but having existed longer. Per-day is the same popularity, without the
 * head start.
 *
 * A repository with no publication date is treated as old, because the only ones
 * missing it are old enough to predate the field.
 */
export function uptakeRate(hit: { downloads?: number; createdAt?: string }, now: number): number {
  const downloads = hit.downloads ?? 0
  if (downloads < MIN_DOWNLOADS_TO_RANK) return 0
  const published = hit.createdAt ? Date.parse(hit.createdAt) : NaN
  const ageDays = Number.isNaN(published) ? 3650 : Math.max(1, (now - published) / DAY_MS)
  return downloads / ageDays
}

/**
 * Best-effort guess at whether a live-discovered model supports tool/function
 * calling — Hugging Face has no verified field for this. Seeded with facts
 * this project already learned through real, hands-on reliability testing
 * (see `anodex-project` memory: Qwen Coder models call tools correctly,
 * DeepSeek Coder V2 Lite and Mistral mostly don't), not guessed from
 * scratch — the same reasoning `RECOMMENDED_MODELS`' hand-set `supportsTools`
 * values were originally based on. Falls back to an explicit tag/text
 * mention of tool- or function-calling for anything not covered by name.
 * Deliberately conservative (`false`, not `undefined`) so an untested model
 * never silently qualifies for "Best Agent" — only a real reliability record
 * (see `reliabilityScoreForRecommended`) should ever override this guess.
 */
export function inferSupportsTools(repoId: string, tags: string[]): boolean {
  const name = repoId.toLowerCase()
  // Scoped to the Qwen *Coder* line specifically — that's the part of the
  // family this project actually tested. A plain small Qwen instruct/base
  // model (e.g. `Qwen2.5-0.5B-Instruct`) hasn't been verified and shouldn't
  // inherit the Coder line's reliability by name association alone.
  if (/qwen.*coder/.test(name)) return true
  if (/deepseek/.test(name)) return false
  if (/mistral|mixtral/.test(name)) return false
  const haystack = `${name} ${tags.join(' ')}`.toLowerCase()
  return /tool[-_ ]?call|function[-_ ]?call|\bagentic\b/.test(haystack)
}

/** A single file entry from Hugging Face's `siblings` list, with size once `?blobs=true` is used. */
interface HfSibling {
  rfilename: string
  size?: number
}

interface HfSearchHit {
  id: string
  downloads?: number
  likes?: number
  tags?: string[]
  pipeline_tag?: string
  /** When the repository was published, e.g. `2026-08-13T09:02:11.000Z`. */
  createdAt?: string
}

interface HfModelDetail {
  id: string
  siblings?: HfSibling[]
  gguf?: { context_length?: number; architecture?: string }
  tags?: string[]
}

/** Quantizations preferred in order, when more than one single-file option exists. */
const QUANT_PREFERENCE = ['q4_k_m', 'q4_0', 'q5_k_m', 'q5_0', 'q6_k', 'q8_0', 'q3_k_m', 'q2_k']

/**
 * Parts of a repository that are not the model, whatever their quant says.
 *
 * `mtp-` is a multi-token-prediction module — a small draft head published
 * beside the model it speeds up. `unsloth/gemma-4-12B-it-qat-GGUF` ships four of
 * them, and its 242MB `MTP/mtp-gemma-4-12B-it-Q4_0.gguf` was what Anodex offered
 * as "gemma-4-12B", a 12-billion-parameter model, in 0.4 GB. Downloading it
 * gives you something that cannot answer anything.
 */
const NOT_THE_MODEL = /(^|\/)(mtp-|draft-)/i

/**
 * True for a GGUF filename that's one whole piece of the model. Multi-part
 * files (`...-00001-of-00004.gguf`) need a separate merge step our downloader
 * doesn't do, so they're excluded rather than silently downloading a broken
 * partial model — as are the extra modules some repositories publish alongside
 * the model, and anything in a subfolder, which is where they are usually kept.
 */
export function isSingleFileGguf(filename: string): boolean {
  const name = filename.toLowerCase()
  if (!name.endsWith('.gguf')) return false
  if (/-\d{5}-of-\d{5}\.gguf$/i.test(name)) return false
  if (NOT_THE_MODEL.test(name)) return false
  return !name.includes('/')
}

/** Extracts the quant tag (e.g. `q4_k_m`) from a GGUF filename, or null if none is recognized. */
export function extractQuant(filename: string): string | null {
  const match = filename.toLowerCase().match(/(q[2-8](?:_k(?:_[ms])?|_0)?)/)
  return match ? match[1] : null
}

/**
 * Picks the best single-file GGUF from a repo's file listing — preferring
 * Q4_K_M (the same default the hand-curated catalog uses everywhere), then
 * falling down `QUANT_PREFERENCE`, then any remaining single-file GGUF with a
 * known size. Returns null if the repo has no usable single-file GGUF at all
 * (e.g. every quant is split into parts).
 */
export function pickBestGgufFile(siblings: HfSibling[]): HfSibling | null {
  const candidates = siblings.filter(
    (file): file is HfSibling & { size: number } =>
      typeof file.size === 'number' &&
      isSingleFileGguf(file.rfilename) &&
      !isVisionProjectorFile(file.rfilename)
  )
  if (candidates.length === 0) return null

  for (const quant of QUANT_PREFERENCE) {
    const match = candidates.find((file) => extractQuant(file.rfilename) === quant)
    if (match) return match
  }
  // No recognized quant tag matched — take the largest, which is the model.
  //
  // This used to take the smallest, reasoning that an unknown compression level
  // is safest small. What the quantizers actually publish alongside a model is
  // smaller than the model: the smallest file in a repository is an extra, not a
  // gentler quant, and the newest naming (`UD-Q4_K_XL` and friends) is exactly
  // what this list does not recognise — so the rule reliably picked the wrong
  // file on the repositories it mattered most for.
  return [...candidates].sort((a, b) => b.size - a.size)[0]
}

/** Pick the most broadly compatible projector precision published alongside a vision GGUF. */
export function pickVisionProjector(siblings: HfSibling[]): HfSibling | null {
  const candidates = siblings.filter(
    (file): file is HfSibling & { size: number } =>
      typeof file.size === 'number' &&
      isSingleFileGguf(file.rfilename) &&
      isVisionProjectorFile(file.rfilename)
  )
  if (candidates.length === 0) return null

  for (const precision of ['f16', 'bf16', 'q8_0', 'f32']) {
    const token = new RegExp(`(?:^|[-_.])${precision}(?:[-_.]|$)`, 'i')
    const match = candidates.find((file) => token.test(file.rfilename))
    if (match) return match
  }
  return [...candidates].sort((a, b) => a.size - b.size)[0]
}

function isVisionProjectorFile(filename: string): boolean {
  const name = filename.toLowerCase()
  return (
    name.includes('mmproj') ||
    name.includes('vision-projector') ||
    name.includes('vision_projector') ||
    name.includes('clip-model')
  )
}

/**
 * Estimated RAM needed to run a model of this file size — used only for
 * Hugging Face discoveries, where (unlike the hand-curated catalog) nobody
 * has measured the real number. Deliberately generous: it's built from the
 * curated catalog's own size-to-RAM ratios but rounded up, since
 * under-recommending risks a native OOM crash (a real, previously-hit failure
 * mode in this app) while over-recommending just means a cautious estimate.
 */
export function estimateRamRequirements(sizeBytes: number): {
  minRamGb: number
  idealRamGb: number
} {
  const sizeGb = sizeBytes / 1024 ** 3
  const minRamGb = Math.ceil(sizeGb * 2.8 + 3)
  const idealRamGb = Math.ceil(sizeGb * 4 + 4)
  return { minRamGb, idealRamGb }
}

/**
 * Coarse tier from file size, for `ModelTier`-based matching (see
 * `contextSizeFor`). Boundaries are calibrated against the curated catalog's
 * own Q4_K_M sizes (e.g. its 7B entries run 4.4–5.8 GB, its 32B entry is
 * 19.8 GB), not evenly spaced — model sizes within a tier vary more than the
 * gaps between tiers.
 */
export function estimateTier(sizeBytes: number): ModelTier {
  const sizeGb = sizeBytes / 1024 ** 3
  if (sizeGb < 1.5) return '1b'
  if (sizeGb < 3.5) return '3b'
  if (sizeGb < 8) return '7b'
  if (sizeGb < 17) return '14b'
  if (sizeGb < 30) return '32b'
  return '70b'
}

/**
 * Best-effort "is this a coding model" guess from its repo id and Hugging
 * Face tags — the same kind of text heuristic `scoreInstalledModel` already
 * uses for locally-added GGUFs, since Hugging Face has no verified field for
 * this (nor for tool-calling support, which is left `undefined` here rather
 * than guessed).
 */
export function inferPrimaryUse(repoId: string, tags: string[]): 'coding' | 'general' {
  const haystack = `${repoId} ${tags.join(' ')}`.toLowerCase()
  return /code|coder|coding|codeqwen/.test(haystack) ? 'coding' : 'general'
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`Hugging Face returned HTTP ${response.status}`)
    return (await response.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

/** Converts one Hugging Face repo + its chosen file into a `RecommendedModel`. */
function toRecommendedModel(
  hit: HfSearchHit,
  file: HfSibling,
  contextLength?: number,
  projector?: HfSibling | null
): RecommendedModel {
  const size = file.size ?? 0
  const totalRuntimeSize = size + (projector?.size ?? 0)
  const { minRamGb, idealRamGb } = estimateRamRequirements(totalRuntimeSize)
  const quant = extractQuant(file.rfilename)
  const displayName = `${hit.id.split('/').pop() ?? hit.id}${quant ? ` (${quant.toUpperCase()})` : ''}`
  const primaryUse = inferPrimaryUse(hit.id, hit.tags ?? [])
  const supportsTools = inferSupportsTools(hit.id, hit.tags ?? [])

  return {
    id: `hf:${hit.id}:${file.rfilename}`,
    name: displayName,
    family: inferModelFamily(hit.id),
    tier: estimateTier(size),
    description:
      contextLength && contextLength > 8192
        ? `Community GGUF from Hugging Face · ${contextLength.toLocaleString()}-token native context.`
        : 'Community GGUF from Hugging Face.',
    approxSize: `${(totalRuntimeSize / 1024 ** 3).toFixed(1)} GB`,
    minRam: `${minRamGb} GB`,
    minRamGb,
    idealRamGb,
    downloadUrl: `https://huggingface.co/${hit.id}/resolve/main/${file.rfilename}`,
    visionProjectorUrl: projector
      ? `https://huggingface.co/${hit.id}/resolve/main/${projector.rfilename}`
      : undefined,
    visionProjectorFileName: projector
      ? `${hit.id.split('/').pop() ?? 'model'}-${projector.rfilename.split('/').pop()}`
      : undefined,
    tags:
      primaryUse === 'coding'
        ? ['coding', ...(projector ? ['vision'] : []), 'community']
        : [...(projector ? ['vision'] : []), 'community'],
    primaryUse,
    // qualityRank/speedRank deliberately left unset — `scoreRecommendedModel`
    // already treats a missing rank as neutral (3/5), which is more honest
    // than inventing a number nobody has actually measured for this model.
    supportsTools,
    source: 'huggingface',
    repoId: hit.id,
    publishedAt: hit.createdAt,
    hfDownloads: hit.downloads,
    hfLikes: hit.likes
  }
}

/**
 * Fine-tunes nobody should be handed as a default.
 *
 * A recommendation is Anodex speaking for itself. Ranking by uptake surfaced
 * `orcarouter_Qwen3.8-27B-Uncensored-GGUF` as the best agent model for this
 * machine — a genuinely popular repository, and not a thing to put in front of
 * somebody who has just opened the app and asked for a model.
 */
const NOVELTY = /uncensored|abliterated|nsfw|roleplay|erotic|waifu|jailbreak/i

/** The quantizers on {@link TRUSTED_PUBLISHERS}, who publish other people's models. */
const QUANTIZERS = new Set(['bartowski', 'unsloth'])

/**
 * Whether a repository is one Anodex should recommend on its own initiative.
 *
 * Trusting the publisher was enough while the ranking was "most downloaded of
 * all time", which only ever surfaced the famous. Asking what is being taken up
 * now reaches further down the list, and a quantizer's list is mostly other
 * people's fine-tunes: `endless-frontier_BigBang-v1`, `XYZAILab_XYZ-Aquila-mini`
 * and `Kwaipilot_KAT-Coder-V2.5-Dev` all arrived in one live fetch.
 *
 * So a quantizer's repository has to name a model from a family Anodex knows —
 * the same families it can show a real logo for. `google_gemma-3-27b-it` is
 * Gemma whoever published it; `Kwaipilot_KAT-Coder-V2.5-Dev` is nothing this
 * list is built on. A lab publishing its own GGUF is trusted as it always was,
 * and nothing here narrows a search the user typed: what somebody asks for by
 * name, they get.
 */
export function isRecommendableRepo(id: string): boolean {
  if (NOVELTY.test(id)) return false
  const [author, name = ''] = id.split('/')
  if (!QUANTIZERS.has(author?.toLowerCase() ?? '')) return true
  return inferModelFamily(name) !== 'other'
}

/**
 * Things that are not somebody to talk to.
 *
 * A GGUF is a file format, not a kind of model: speech recognisers, speech
 * synthesizers, embedders and rerankers all ship as GGUF and all turn up in a
 * browse of them. `microsoft/VibeVoice-ASR-BitNet` — speech to text — was
 * offered on a real machine as the model with the largest context.
 */
const NOT_SOMETHING_TO_TALK_TO = new Set([
  'feature-extraction',
  'sentence-similarity',
  'automatic-speech-recognition',
  'text-to-speech',
  'text-to-audio',
  'audio-to-audio',
  'audio-classification',
  'text-to-image',
  'image-to-image',
  'fill-mask',
  'text-classification',
  'token-classification',
  'text-ranking'
])

/** True for a chat/instruct-style text model — excludes embedders and rerankers,
 *  and the speech and image models that ship as GGUF alongside them. */
function isChatModel(hit: HfSearchHit): boolean {
  if (hit.pipeline_tag && NOT_SOMETHING_TO_TALK_TO.has(hit.pipeline_tag)) return false
  const tags = hit.tags ?? []
  if (tags.some((tag) => NOT_SOMETHING_TO_TALK_TO.has(tag))) return false
  if (tags.includes('sentence-transformers')) return false
  // Named plainly enough to catch the ones whose listing carries no pipeline tag
  // at all: `Qwen3-Embedding-0.6B-GGUF`, `VibeVoice-ASR-BitNet`, `...-TTS-...`.
  return !/\bembedding\b|\b(asr|tts|stt)\b|reranker/i.test(hit.id)
}

/** Fetches full details for each hit and resolves it to a downloadable
 *  `RecommendedModel`, dropping any repo with no usable single-file GGUF or a
 *  failed detail lookup — shared by both the manual search and the
 *  auto-populated "top picks" path so they can't drift out of sync. */
async function resolveHitsToModels(hits: HfSearchHit[]): Promise<RecommendedModel[]> {
  const results = await Promise.all(
    hits.map(async (hit) => {
      try {
        const detailUrl = `https://huggingface.co/api/models/${hit.id}?blobs=true`
        const detail = await fetchJson<HfModelDetail>(detailUrl, DETAIL_TIMEOUT_MS)
        const file = pickBestGgufFile(detail.siblings ?? [])
        if (!file) return null
        const projector = pickVisionProjector(detail.siblings ?? [])
        return toRecommendedModel(hit, file, detail.gguf?.context_length, projector)
      } catch (error) {
        // One repo failing (rate limit, malformed metadata) shouldn't drop the
        // rest of an otherwise-good result set.
        log.warn(
          'Skipping Hugging Face repo after detail fetch failure',
          hit.id,
          toErrorMessage(error)
        )
        return null
      }
    })
  )
  return results.filter((model): model is RecommendedModel => model !== null)
}

/**
 * Searches Hugging Face for GGUF models matching `query`, resolving each hit
 * to a downloadable single-file quant with an estimated hardware fit. Network
 * or parse failures degrade to an empty, honestly-labeled result rather than
 * throwing — a failed online search should never break the (fully offline)
 * curated recommendations sitting right next to it.
 */
export async function searchHuggingFaceModels(query: string): Promise<Result<RecommendedModel[]>> {
  const trimmed = query.trim()
  if (!trimmed) return ok([])

  let hits: HfSearchHit[]
  try {
    const searchUrl = `https://huggingface.co/api/models?search=${encodeURIComponent(trimmed)}&filter=gguf&sort=downloads&direction=-1&limit=${MAX_DETAILED_RESULTS}`
    hits = await fetchJson<HfSearchHit[]>(searchUrl, SEARCH_TIMEOUT_MS)
  } catch (error) {
    log.warn('Hugging Face search failed', toErrorMessage(error))
    return err(
      'models.discover-failed',
      'Could not reach Hugging Face. Check your connection and try again.',
      toErrorMessage(error)
    )
  }

  return ok(await resolveHitsToModels(hits))
}

/** Opening Settings re-mounts the page that calls `fetchTopModels` — cache
 *  briefly so that doesn't re-run ~8 publisher queries plus up to 24 detail
 *  fetches every time, while still refreshing within a single sitting. */
const TOP_MODELS_CACHE_MS = 15 * 60 * 1000
let topModelsCache: { result: Result<RecommendedModel[]>; at: number } | null = null

/** Test-only: clears the in-memory cache so each test starts from a clean slate. */
export function resetTopModelsCacheForTests(): void {
  topModelsCache = null
}

/**
 * Auto-populates "Recommended for your PC" with current, popular models —
 * the live counterpart to the hand-maintained `RECOMMENDED_MODELS` catalog,
 * so a new model generation (e.g. Qwen3 after Qwen2.5) shows up without an
 * Anodex code change. Scoped to `TRUSTED_PUBLISHERS` rather than a global
 * downloads sort, which otherwise surfaces embedding models and novelty
 * fine-tunes ahead of the models actually worth recommending as a default.
 * Network failures degrade to an empty, honestly-labeled result — the static
 * catalog is always merged in alongside this on the renderer side, so a
 * failed or offline fetch still leaves a usable recommendation list.
 */
export async function fetchTopModels(): Promise<Result<RecommendedModel[]>> {
  if (topModelsCache && Date.now() - topModelsCache.at < TOP_MODELS_CACHE_MS) {
    return topModelsCache.result
  }

  let hits: HfSearchHit[]
  try {
    const queryUrl = (author: string, sort: string, search?: string): string =>
      `https://huggingface.co/api/models?author=${encodeURIComponent(author)}${
        search ? `&search=${encodeURIComponent(search)}` : ''
      }&filter=gguf&sort=${sort}&direction=-1&limit=${MAX_PER_PUBLISHER}`

    const fetchFor = (author: string, sort: string, search?: string): Promise<HfSearchHit[]> =>
      fetchJson<HfSearchHit[]>(queryUrl(author, sort, search), SEARCH_TIMEOUT_MS).catch((error) => {
        log.warn(
          'Hugging Face top-models fetch failed for publisher',
          author,
          `${sort}${search ? ` ${search}` : ''}`,
          toErrorMessage(error)
        )
        return [] as HfSearchHit[]
      })

    const perPublisher = await Promise.all(
      TRUSTED_PUBLISHERS.flatMap((author) => [
        ...SORTS.map((sort) => fetchFor(author, sort)),
        // By what is being taken up rather than by all-time downloads: a
        // downloads sort here returns the coding model of two years ago, which
        // is how a 2024 model came to be offered as "Best Coding" on a machine
        // that can run this year's.
        fetchFor(author, 'trendingScore', CODING_SEARCH_TERM)
      ])
    )
    const byId = new Map<string, HfSearchHit>()
    for (const hit of perPublisher.flat()) {
      if (!byId.has(hit.id)) byId.set(hit.id, hit)
    }
    const now = Date.now()
    hits = [...byId.values()]
      .filter(isChatModel)
      .filter((hit) => isRecommendableRepo(hit.id))
      .sort((a, b) => uptakeRate(b, now) - uptakeRate(a, now))
      .slice(0, MAX_TOP_MODELS)
  } catch (error) {
    log.warn('Hugging Face top-models fetch failed', toErrorMessage(error))
    // Not cached — a transient failure shouldn't lock the app out of a real
    // result for the next 15 minutes if the network recovers sooner.
    return err(
      'models.discover-failed',
      'Could not reach Hugging Face. Showing the built-in catalog instead.',
      toErrorMessage(error)
    )
  }

  if (hits.length === 0) {
    return err(
      'models.discover-failed',
      'Could not reach Hugging Face. Showing the built-in catalog instead.'
    )
  }

  const result = ok(await resolveHitsToModels(hits))
  topModelsCache = { result, at: Date.now() }
  return result
}
