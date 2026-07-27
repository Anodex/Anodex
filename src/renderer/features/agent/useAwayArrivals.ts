import { useEffect, useRef, useState } from 'react'
import type { AgentRun } from '@shared/agentRun.types'
import { claimArrival, isUnannouncedArrival } from '../../components/ui/useArrival'
import { isTerminalStatus } from './agentRunFormat'

/**
 * Below this many landings there is no "while you were away" to announce —
 * one run finishing is just a run finishing, and its own arrival glow already
 * says so. Announcing a single run would make the band routine, and a band
 * that appears constantly stops reading as an event.
 */
const MIN_AWAY_RUNS = 2

/** Beat before the first run is announced, so the band gets read first. */
const LEAD_MS = 340

/** How long the beam rests on each run before travelling to the next. */
const STEP_MS = 700

interface AwayMoment {
  ids: string[]
  /** Set once the sweep has finished, so it can never run a second time. */
  played: boolean
}

/**
 * The one "you came back" moment for this app launch. Module-level rather than
 * component state because coming back is a fact about the session, not about a
 * mounted component: switching to another view and returning is not a second
 * homecoming, and must not replay the sweep.
 */
let moment: AwayMoment | null = null

/**
 * Which runs count as having landed while the user was away: terminal, not yet
 * announced, and enough of them to be a homecoming rather than a single run
 * finishing. Below the threshold this returns nothing at all, leaving each card
 * to announce itself the way it always has.
 *
 * `isNew` is injected so this stays a pure decision — the real predicate reads
 * module-level announce state, which a test has no way to reset.
 */
export function selectAwayRuns(runs: AgentRun[], isNew: (run: AgentRun) => boolean): AgentRun[] {
  const landed = runs.filter((run) => isTerminalStatus(run.status) && isNew(run))
  return landed.length >= MIN_AWAY_RUNS ? landed : []
}

/**
 * Decides, once per app launch, which runs finished while the user was away.
 *
 * Deliberately does *not* let the cards claim their own arrivals. React runs
 * effects child-first, so a card's own `useArrival` would claim its landing
 * before this ever saw it and every card would announce itself independently —
 * exactly the uncoordinated flash this replaces. Instead the view passes
 * `orchestrated` down and the cards stand down by argument.
 */
function captureMoment(runs: AgentRun[]): AwayMoment {
  if (moment) return moment
  const landed = selectAwayRuns(runs, (run) => isUnannouncedArrival(run.id, run.updatedAt))
  const ids = landed.map((run) => run.id)
  ids.forEach(claimArrival)
  moment = { ids, played: false }
  return moment
}

export interface AwayArrivals {
  /** Runs that landed while the user was away, in list order. Empty when there was no such moment. */
  runs: AgentRun[]
  /** True while this view owns the arrival glows — cards must not announce themselves. */
  orchestrated: (runId: string) => boolean
  /** The run being announced right now; its glow plays as the beam reaches it. */
  spotlightId: string | null
  /** True while the beam is travelling the list. */
  sweeping: boolean
  dismissed: boolean
  dismiss: () => void
}

/**
 * Announces a homecoming: several runs finished unattended and the user has
 * just opened Agent to find them.
 *
 * The band states the fact and stays until dismissed — that's information, and
 * information doesn't expire on a timer. The beam is the motion, and it runs
 * once: it rests on each landing in turn so three arrivals read as a sequence
 * you can follow rather than a flash you can't, then it goes.
 */
export function useAwayArrivals(runs: AgentRun[], ready: boolean): AwayArrivals {
  const [spotlightId, setSpotlightId] = useState<string | null>(null)
  const [sweeping, setSweeping] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const startedRef = useRef(false)

  // Captured during render so the ids are known before any card renders, but
  // only once the store has actually loaded — capturing against an empty list
  // would decide "nothing arrived" before the runs exist.
  const captured = ready ? captureMoment(runs) : null
  const ids = captured?.ids ?? []
  const idSet = new Set(ids)

  useEffect(() => {
    if (!captured || captured.ids.length === 0 || captured.played) return
    if (startedRef.current) return
    startedRef.current = true

    const timers: ReturnType<typeof setTimeout>[] = []
    let index = 0
    const step = (): void => {
      if (index >= captured.ids.length) {
        captured.played = true
        setSpotlightId(null)
        setSweeping(false)
        return
      }
      setSpotlightId(captured.ids[index])
      index += 1
      timers.push(setTimeout(step, STEP_MS))
    }
    setSweeping(true)
    timers.push(setTimeout(step, LEAD_MS))

    return () => timers.forEach(clearTimeout)
  }, [captured])

  return {
    runs: runs.filter((run) => idSet.has(run.id)),
    orchestrated: (runId: string) => idSet.has(runId),
    spotlightId,
    sweeping,
    dismissed,
    dismiss: () => setDismissed(true)
  }
}
