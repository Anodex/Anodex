import { useEffect, useRef, useState } from 'react'
import type { StatusTone } from './StatusDot'

export type CometPhase = 'loading' | 'approach' | 'arriving' | 'settled'

const APPROACH_DELAY_MS = 2400
const ARRIVE_MS = 500

/**
 * Tracks a StatusTone's loading -> success transition and returns the
 * comet's current phase, for `CometStatusDot`. The tone -> phase mapping
 * happens synchronously during render (not in an effect) so an
 * already-in-flight arrival can't lose a frame to a plain-colored dot
 * before the flare kicks in — this matters whenever the caller might swap
 * which JSX branch (and which dot element) is mounted right as loading
 * resolves to ready, as `ModelStatusMenu` does.
 */
export function useCometPhase(tone: StatusTone): CometPhase {
  const [phase, setPhase] = useState<CometPhase>(tone === 'running' ? 'loading' : 'settled')
  const [prevTone, setPrevTone] = useState(tone)
  const timer = useRef<ReturnType<typeof setTimeout>>()

  if (tone !== prevTone) {
    setPrevTone(tone)
    if (tone === 'running') setPhase('loading')
    else if (prevTone === 'running' && tone === 'success') setPhase('arriving')
    else setPhase('settled')
  }

  useEffect(() => {
    clearTimeout(timer.current)
    if (phase === 'loading') {
      timer.current = setTimeout(() => setPhase('approach'), APPROACH_DELAY_MS)
    } else if (phase === 'arriving') {
      timer.current = setTimeout(() => setPhase('settled'), ARRIVE_MS)
    }
    return () => clearTimeout(timer.current)
  }, [phase])

  return phase
}
