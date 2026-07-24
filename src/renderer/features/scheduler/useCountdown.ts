import { useEffect, useState } from 'react'

/**
 * How often to re-render a countdown, chosen from how far out it is. A task
 * three days away has nothing to say every second, and ticking every card in
 * the list at 1Hz regardless of distance is wasted render work — but anything
 * inside an hour shows seconds, so it has to tick at 1Hz to stay honest.
 */
function tickIntervalFor(msRemaining: number): number {
  if (msRemaining <= 0) return 30_000
  if (msRemaining < 60 * 60_000) return 1000
  if (msRemaining < 24 * 60 * 60_000) return 30_000
  return 5 * 60_000
}

/**
 * Re-renders on a timer so a countdown derived from `Date.now()` actually
 * counts down. Without this, `formatNextRun` is computed once during render and
 * then frozen — the number is correct when drawn and stale a second later,
 * which reads as a static label rather than a live one.
 *
 * Returns a value that changes on each tick; callers ignore it and just
 * recompute their own formatting.
 */
export function useCountdown(target: number | null): number {
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (target === null) return
    let timer: ReturnType<typeof setTimeout>

    const schedule = (): void => {
      timer = setTimeout(
        () => {
          setTick((value) => value + 1)
          schedule()
        },
        tickIntervalFor(target - Date.now())
      )
    }
    schedule()

    return () => clearTimeout(timer)
  }, [target])

  return tick
}
