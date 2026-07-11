import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type {
  ChartGranularity,
  ChartRange,
  UsageBreakdown,
  UsageProfile
} from '@shared/stats.types'
import { createLogger } from '../utils/logger'
import {
  buildChartBuckets,
  buildModelBreakdown,
  buildUsageProfile,
  emptyTokenActivityRecord,
  type TokenActivityRecord
} from './tokenActivityMath'

const log = createLogger('token-activity')

/** Local calendar day (`YYYY-MM-DD`) — bucketing/streaks are day-boundary math on this. */
function localDateString(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export interface RecordGenerationInput {
  /** Output (generated) tokens. */
  tokens: number
  /** Approximate input tokens for this turn — see `LlamaService.countPromptTokens`. */
  inputTokens: number
  durationMs: number
  toolNames: string[]
  conversationId: string
  modelId: string
  modelName: string
}

/**
 * Persists all-time token-generation activity in its own
 * `userData/token-activity/stats.json` — independent of individual
 * conversations (which can be deleted without losing usage history),
 * following the same singleton pattern as `ModelReliabilityStore`.
 */
class TokenActivityStore {
  private filePath = ''
  private record: TokenActivityRecord = emptyTokenActivityRecord()

  /** Must be called after `app.whenReady()`. */
  init(): void {
    const dir = join(app.getPath('userData'), 'token-activity')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    this.filePath = join(dir, 'stats.json')
    this.record = this.load()
    log.info('Initialised at', this.filePath)
  }

  /** Record one completed generation's contribution to today's activity. */
  recordGeneration({
    tokens,
    inputTokens,
    durationMs,
    toolNames,
    conversationId,
    modelId,
    modelName
  }: RecordGenerationInput): void {
    const today = localDateString(new Date())
    const bucket = this.record.daily[today] ?? { tokens: 0, generations: 0, models: {} }
    bucket.tokens += tokens
    bucket.generations += 1

    const modelBucket = bucket.models[modelId] ?? { modelName, inputTokens: 0, outputTokens: 0 }
    modelBucket.inputTokens += inputTokens
    modelBucket.outputTokens += tokens
    modelBucket.modelName = modelName // keep the display name fresh if a model file gets renamed
    bucket.models[modelId] = modelBucket

    this.record.daily[today] = bucket

    const hour = String(new Date().getHours())
    this.record.hourly[hour] = (this.record.hourly[hour] ?? 0) + 1

    if (!this.record.sessionIds.includes(conversationId)) {
      this.record.sessionIds.push(conversationId)
    }

    for (const name of toolNames) {
      this.record.toolUsage[name] = (this.record.toolUsage[name] ?? 0) + 1
    }

    if (durationMs > this.record.longestGenerationDurationMs) {
      this.record.longestGenerationDurationMs = durationMs
      this.record.longestGenerationDate = today
    }

    this.persist()
  }

  /**
   * Sum of input+output tokens recorded today across a set of model ids —
   * used to total a cloud provider's usage from its curated model id list
   * (`ANTHROPIC_MODELS`/`OPENAI_MODELS`), since a generation's `modelId` is
   * the cloud model id itself (see `activeModelDescriptor` in
   * `chat.handlers.ts`), not a separate provider field.
   */
  getTodayTokensForModelIds(modelIds: readonly string[]): number {
    const bucket = this.record.daily[localDateString(new Date())]
    if (!bucket) return 0
    return modelIds.reduce((sum, id) => {
      const model = bucket.models[id]
      return sum + (model ? model.inputTokens + model.outputTokens : 0)
    }, 0)
  }

  /**
   * Record token spend from a non-generation API call — currently just the
   * cloud providers' context-compaction summary call (see
   * `summarizeForCompactionOpenAi`/`summarizeForCompactionAnthropic`), which
   * is real billed usage but produces no chat turn. Folds into the same daily/
   * model token totals the usage gauge and daily-cap comparison read (so that
   * spend is no longer invisible to them), but deliberately skips
   * `generations`/`sessionIds`/`toolUsage`/duration bookkeeping — those are
   * all specifically about assistant replies, and this call isn't one.
   */
  recordAncillaryUsage({
    inputTokens,
    outputTokens,
    modelId,
    modelName
  }: {
    inputTokens: number
    outputTokens: number
    modelId: string
    modelName: string
  }): void {
    const today = localDateString(new Date())
    const bucket = this.record.daily[today] ?? { tokens: 0, generations: 0, models: {} }
    bucket.tokens += inputTokens + outputTokens

    const modelBucket = bucket.models[modelId] ?? { modelName, inputTokens: 0, outputTokens: 0 }
    modelBucket.inputTokens += inputTokens
    modelBucket.outputTokens += outputTokens
    modelBucket.modelName = modelName
    bucket.models[modelId] = modelBucket

    this.record.daily[today] = bucket
    this.persist()
  }

  getUsageProfile(): UsageProfile {
    return buildUsageProfile(this.record, localDateString(new Date()))
  }

  getUsageBreakdown(range: ChartRange, granularity: ChartGranularity): UsageBreakdown {
    return {
      models: buildModelBreakdown(this.record),
      chart: buildChartBuckets(this.record, range, granularity, localDateString(new Date()))
    }
  }

  /**
   * Tolerates on-disk files written before `models`/`hourly`/`sessionIds`
   * existed — a plain defaulting merge, not a versioned migration, since
   * every new field is purely additive and safely defaultable.
   */
  private load(): TokenActivityRecord {
    if (!existsSync(this.filePath)) return emptyTokenActivityRecord()
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf-8')) as Partial<TokenActivityRecord>
      return {
        daily: Object.fromEntries(
          Object.entries(raw.daily ?? {}).map(([date, bucket]) => [
            date,
            {
              tokens: bucket.tokens ?? 0,
              generations: bucket.generations ?? 0,
              models: bucket.models ?? {}
            }
          ])
        ),
        toolUsage: raw.toolUsage ?? {},
        longestGenerationDurationMs: raw.longestGenerationDurationMs ?? 0,
        longestGenerationDate: raw.longestGenerationDate ?? null,
        hourly: raw.hourly ?? {},
        sessionIds: raw.sessionIds ?? []
      }
    } catch (error) {
      log.warn('Failed to parse token activity data, starting fresh:', error)
      return emptyTokenActivityRecord()
    }
  }

  private persist(): void {
    try {
      writeFileSync(this.filePath, JSON.stringify(this.record, null, 2), 'utf-8')
    } catch (error) {
      log.error('Failed to persist token activity data:', error)
    }
  }
}

export const tokenActivityStore = new TokenActivityStore()
