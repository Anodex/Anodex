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
 * True for a GGUF filename that's one whole piece of the model. Multi-part
 * files (`...-00001-of-00004.gguf`) need a separate merge step our downloader
 * doesn't do, so they're excluded rather than silently downloading a broken
 * partial model.
 */
export function isSingleFileGguf(filename: string): boolean {
  return filename.toLowerCase().endsWith('.gguf') && !/-\d{5}-of-\d{5}\.gguf$/i.test(filename)
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
      typeof file.size === 'number' && isSingleFileGguf(file.rfilename)
  )
  if (candidates.length === 0) return null

  for (const quant of QUANT_PREFERENCE) {
    const match = candidates.find((file) => extractQuant(file.rfilename) === quant)
    if (match) return match
  }
  // No recognized quant tag matched — fall back to the smallest file, since an
  // unrecognized-but-present quant is still better than nothing, and the
  // smallest is the safest default for an unknown compression level.
  return [...candidates].sort((a, b) => a.size - b.size)[0]
}

/**
 * Estimated RAM needed to run a model of this file size — used only for
 * Hugging Face discoveries, where (unlike the hand-curated catalog) nobody
 * has measured the real number. Deliberately generous: it's built from the
 * curated catalog's own size-to-RAM ratios but rounded up, since
 * under-recommending risks a native OOM crash (a real, previously-hit failure
 * mode in this app) while over-recommending just means a cautious estimate.
 */
export function estimateRamRequirements(sizeBytes: number): { minRamGb: number; idealRamGb: number } {
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
function toRecommendedModel(hit: HfSearchHit, file: HfSibling, contextLength?: number): RecommendedModel {
  const size = file.size ?? 0
  const { minRamGb, idealRamGb } = estimateRamRequirements(size)
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
    approxSize: `${(size / 1024 ** 3).toFixed(1)} GB`,
    minRam: `${minRamGb} GB`,
    minRamGb,
    idealRamGb,
    downloadUrl: `https://huggingface.co/${hit.id}/resolve/main/${file.rfilename}`,
    tags: primaryUse === 'coding' ? ['coding', 'community'] : ['community'],
    primaryUse,
    // qualityRank/speedRank deliberately left unset — `scoreRecommendedModel`
    // already treats a missing rank as neutral (3/5), which is more honest
    // than inventing a number nobody has actually measured for this model.
    supportsTools,
    source: 'huggingface',
    repoId: hit.id,
    hfDownloads: hit.downloads,
    hfLikes: hit.likes
  }
}

/** True for a chat/instruct-style text model — excludes embedding/reranker
 *  repos, which otherwise show up in a plain downloads-sorted GGUF browse. */
function isChatModel(hit: HfSearchHit): boolean {
  if (hit.pipeline_tag === 'feature-extraction' || hit.pipeline_tag === 'sentence-similarity') {
    return false
  }
  const tags = hit.tags ?? []
  if (tags.includes('sentence-transformers') || tags.includes('feature-extraction')) return false
  // Embedding-model repos are reliably named as such (e.g.
  // `Qwen3-Embedding-0.6B-GGUF`) even when the list endpoint omits
  // `pipeline_tag`/tags that would otherwise flag them above.
  if (/\bembedding\b/i.test(hit.id)) return false
  return true
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
        return toRecommendedModel(hit, file, detail.gguf?.context_length)
      } catch (error) {
        // One repo failing (rate limit, malformed metadata) shouldn't drop the
        // rest of an otherwise-good result set.
        log.warn('Skipping Hugging Face repo after detail fetch failure', hit.id, toErrorMessage(error))
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
    const queryUrl = (author: string, search?: string): string =>
      `https://huggingface.co/api/models?author=${encodeURIComponent(author)}${
        search ? `&search=${encodeURIComponent(search)}` : ''
      }&filter=gguf&sort=downloads&direction=-1&limit=${MAX_PER_PUBLISHER}`

    const fetchFor = (author: string, search?: string): Promise<HfSearchHit[]> =>
      fetchJson<HfSearchHit[]>(queryUrl(author, search), SEARCH_TIMEOUT_MS).catch((error) => {
        log.warn(
          'Hugging Face top-models fetch failed for publisher',
          author,
          search ?? '(general)',
          toErrorMessage(error)
        )
        return [] as HfSearchHit[]
      })

    const perPublisher = await Promise.all(
      TRUSTED_PUBLISHERS.flatMap((author) => [fetchFor(author), fetchFor(author, CODING_SEARCH_TERM)])
    )
    const byId = new Map<string, HfSearchHit>()
    for (const hit of perPublisher.flat()) {
      if (!byId.has(hit.id)) byId.set(hit.id, hit)
    }
    hits = [...byId.values()]
      .filter(isChatModel)
      .sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0))
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
