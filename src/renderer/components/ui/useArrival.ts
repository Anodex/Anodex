import { useEffect, useRef, useState } from 'react'

/**
 * How recently something must have landed for its arrival to still be worth
 * announcing. Reopening a view after being away for days shouldn't make the
 * whole list glow at once — by then these aren't arrivals, they're history.
 */
export const ARRIVAL_WINDOW_MS = 5 * 60 * 1000

/**
 * Keys already announced this session. Module-level rather than component
 * state so switching away from a view and back doesn't replay an arrival the
 * user has already been shown, while a fresh app launch still can.
 */
const announced = new Set<string>()

/** True if this key has never been announced and landed recently enough to still count. */
export function isUnannouncedArrival(key: string, landedAt: number, now = Date.now()): boolean {
  return !announced.has(key) && now - landedAt <= ARRIVAL_WINDOW_MS
}

/** Marks a key announced without playing anything — for a caller sequencing arrivals itself. */
export function claimArrival(key: string): void {
  announced.add(key)
}

/**
 * True for one render pass when something finished that the user hasn't been
 * shown yet — whether they watched it happen, or (the realistic case for
 * unattended work) they're opening the view for the first time after it
 * already finished.
 *
 * `key` identifies the specific landing, not the thing that landed: an agent
 * run reaches a terminal status once and can use its own id, while a scheduled
 * task runs over and over and has to fold in *which* run, or its second run
 * would be silently treated as already announced. Pass null when there is no
 * landing to announce.
 */
export function useArrival(key: string | null, landedAt: number | null): boolean {
  const [arrived, setArrived] = useState(false)
  const claimedRef = useRef(false)

  useEffect(() => {
    if (key === null || landedAt === null || claimedRef.current) return
    if (!isUnannouncedArrival(key, landedAt)) return
    claimArrival(key)
    claimedRef.current = true
    setArrived(true)
  }, [key, landedAt])

  return arrived
}
