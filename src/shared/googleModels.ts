/**
 * Curated list of Google Gemini models offered in the Google AI provider
 * settings, accessed through Gemini's OpenAI-compatible endpoint (see
 * `OpenAiCompatibleProvider.ts`) rather than Google's native SDK/API shape.
 *
 * Verified 2026-07-24 via direct fetch of Google's own docs (not a search
 * summary). Google's docs explicitly label the OpenAI-compat layer as
 * "still in beta while we extend feature support" — a newer "Interactions
 * API" is now GA and may get features first; worth rechecking if a specific
 * capability seems to lag.
 */
import type { CloudModelOption } from './cloudModelOption'

export const GOOGLE_MODELS: CloudModelOption[] = [
  {
    id: 'gemini-3.5-flash',
    label: 'Gemini 3.5 Flash',
    description: 'Most intelligent Gemini model — frontier agentic and coding performance.',
    contextWindowTokens: 1_048_576
  },
  {
    id: 'gemini-3.6-flash',
    label: 'Gemini 3.6 Flash',
    description: 'Latest model — balances speed and intelligence.',
    contextWindowTokens: 1_048_576
  },
  {
    id: 'gemini-3.1-pro',
    label: 'Gemini 3.1 Pro',
    description: 'Preview — heaviest reasoning tier.',
    contextWindowTokens: 1_048_576
  },
  {
    id: 'gemini-3.5-flash-lite',
    label: 'Gemini 3.5 Flash-Lite',
    description: 'Fastest and cheapest — good for quick, simple tasks.',
    contextWindowTokens: 1_048_576
  }
]

export const DEFAULT_GOOGLE_MODEL = 'gemini-3.5-flash'
