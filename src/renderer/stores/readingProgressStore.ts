import { create } from 'zustand'
import type { PromptReadingProgress } from '@shared/chat.types'

/**
 * How far the model has read each pending reply's prompt, by message id.
 *
 * Kept apart from the chat store on purpose: progress arrives every couple of
 * thousand tokens during a read, and only the one status line under that reply
 * needs to redraw for it.
 */
interface ReadingProgressState {
  byMessage: Record<string, PromptReadingProgress>
  set: (messageId: string, progress: PromptReadingProgress) => void
}

export const useReadingProgressStore = create<ReadingProgressState>((set) => ({
  byMessage: {},
  set: (messageId, progress) =>
    set((state) => ({ byMessage: { ...state.byMessage, [messageId]: progress } }))
}))

/**
 * Below this many tokens left to read, a read is over before a label could be read,
 * so nothing is shown and the status line does not flicker.
 */
export const MIN_VISIBLE_READ_TOKENS = 1_024

/**
 * "Reading · 45%" while enough of the prompt is still to be read, otherwise null.
 */
export function readingLabel(progress: PromptReadingProgress | undefined): string | null {
  if (!progress || progress.total <= 0) return null
  if (progress.total - progress.done < MIN_VISIBLE_READ_TOKENS) return null
  return `Reading · ${readingPercent(progress)}%`
}

/** Whole percent read, never 100 while reading is still going. */
export function readingPercent(progress: PromptReadingProgress): number {
  return Math.min(99, Math.max(0, Math.floor((progress.done / progress.total) * 100)))
}
