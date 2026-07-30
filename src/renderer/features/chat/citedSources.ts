import type { WebSource } from '@shared/webSources.types'

/** A source plus the display number it shows as, wherever it appears. */
export interface CitedSource {
  number: number
  source: WebSource
}

/**
 * Sources are numbered by the order the model first met them, which is the
 * order their ids were minted — so `[S2]` always renders as 2, both inline and
 * in the source list under the message. One numbering scheme, and a marker
 * whose number doesn't shift when the model cites the same page twice.
 */
export function citedSourceMap(sources: WebSource[] | undefined): Map<string, CitedSource> {
  const map = new Map<string, CitedSource>()
  sources?.forEach((source, index) => map.set(source.id, { number: index + 1, source }))
  return map
}
