import { useRef } from 'react'

interface Sample {
  at: number
  bytes: number
}

export interface DownloadRate {
  bytesPerSecond: number
  secondsLeft: number | null
}

/** How far back the speed looks. Long enough to smooth bursts, short enough to follow a real change. */
const WINDOW_MS = 8000
/** Below this much history the speed is a guess, and a wild one on the first chunk. */
const MIN_SPAN_MS = 2000

/**
 * The speed over the last few seconds, from the progress broadcasts a download
 * already sends. Nothing measures speed at the source, and a rate from the
 * download's start would be skewed by a resumed partial file counted as instant.
 */
export function rateFromSamples(samples: Sample[], totalBytes: number | null): DownloadRate | null {
  if (samples.length < 2) return null
  const first = samples[0]
  const last = samples[samples.length - 1]
  const span = last.at - first.at
  if (span < MIN_SPAN_MS || last.bytes <= first.bytes) return null
  const bytesPerSecond = ((last.bytes - first.bytes) / span) * 1000
  const secondsLeft =
    totalBytes && totalBytes > last.bytes ? (totalBytes - last.bytes) / bytesPerSecond : null
  return { bytesPerSecond, secondsLeft }
}

/** "About 7 min left", in the terms a person waiting would use. */
export function timeLeftLabel(seconds: number): string {
  if (seconds < 60) return 'Less than a minute left'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `About ${minutes} min left`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `About ${hours} h ${rest} min left` : `About ${hours} h left`
}

export function useDownloadRate(
  receivedBytes: number,
  totalBytes: number | null
): DownloadRate | null {
  const samples = useRef<Sample[]>([])
  const now = Date.now()
  const list = samples.current
  const last = list[list.length - 1]
  // A smaller count than before is a restarted download, not a negative speed.
  if (last && receivedBytes < last.bytes) list.length = 0
  if (!last || receivedBytes !== last.bytes) list.push({ at: now, bytes: receivedBytes })
  while (list.length > 2 && now - list[0].at > WINDOW_MS) list.shift()
  return rateFromSamples(list, totalBytes)
}
