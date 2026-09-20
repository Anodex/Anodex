import type { ModelDownloadProgress } from '@shared/model.types'

/** What the bar says, or null when there is nothing to say. */
export interface ActiveDownloadSummary {
  /** One model's name, or how many are running. */
  label: string
  /** Combined progress, or null when no download reported a size. */
  percent: number | null
  /** Every running download's name, for the hover title. */
  names: string[]
}

/**
 * Reduce the download map to the one line the title bar has room for.
 *
 * Separate from the component because this is the part with decisions in it —
 * what to call several downloads at once, and what to do about a server that
 * sent no `content-length` — and because a component reading a zustand store
 * renders its *initial* state under `renderToStaticMarkup`, so the arithmetic
 * could not otherwise be tested without a DOM.
 */
export function summariseActiveDownloads(
  downloads: Record<string, ModelDownloadProgress>,
  names: Record<string, string>
): ActiveDownloadSummary | null {
  const active = Object.values(downloads).filter((entry) => entry.status === 'downloading')
  if (active.length === 0) return null

  // One figure across everything in flight, by bytes rather than by averaging
  // percentages — two downloads of very different sizes are not each half of
  // the progress. A download whose server sent no size is counted on neither
  // side rather than guessed at.
  const measured = active.filter((entry) => entry.totalBytes !== null && entry.totalBytes > 0)
  const received = measured.reduce((sum, entry) => sum + entry.receivedBytes, 0)
  const total = measured.reduce((sum, entry) => sum + (entry.totalBytes ?? 0), 0)

  return {
    label:
      active.length === 1
        ? (names[active[0].modelId] ?? 'Downloading a model')
        : `${active.length} models downloading`,
    percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null,
    names: active.map((entry) => names[entry.modelId] ?? 'Downloading a model')
  }
}
