import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { ChartGranularity, ChartRange, UsageBreakdown, UsageProfile } from '@shared/stats.types'
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
