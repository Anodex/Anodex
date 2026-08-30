/** Everything the Start button checks before it will submit a run. */
export interface StartRequirements {
  goal: string
  limitsEnabled: boolean
  maxTurns: number
  maxTokens: number
  maxDurationMinutes: number
}

/**
 * Why this run cannot start yet, or `null` when it can.
 *
 * The Start button is disabled until a run is valid, and used to be disabled
 * with nothing on screen saying why. That is a silent refusal, and it produced
 * the worst report in the log: the user clicked Start and *nothing happened* —
 * no run, no conversation, no error, and nothing in `anodex.log`, because
 * nothing was ever submitted.
 *
 * A cleared number field is all it takes. `RangeControl` reports
 * `Number(event.target.value)`, and `Number('')` is `0`, so emptying the turn,
 * token or time field silently fails its `>= 1` check. Typing something
 * non-numeric gives `NaN`, which fails every comparison including this one.
 *
 * One definition of the rule, so the button's `disabled` and the message the
 * user reads can never disagree about what is wrong.
 *
 * Everything missing is reported at once. Naming one problem at a time turns a
 * cleared field into a guessing game, which is the same silent-refusal failure
 * wearing a shorter sentence.
 */
export function startBlockedReason(input: StartRequirements): string | null {
  const missing: string[] = []
  if (input.goal.trim().length === 0) missing.push('a goal')

  if (input.limitsEnabled) {
    // `NaN >= 1` is false, so this covers a nonsense entry as well as an empty
    // one — but it is spelled out rather than relied upon.
    if (!(input.maxTurns >= 1)) missing.push('a turn budget of at least 1')
    if (!(input.maxTokens >= 1)) missing.push('a token budget of at least 1')
    if (!(input.maxDurationMinutes >= 1)) missing.push('a time budget of at least 1 minute')
  }

  if (missing.length === 0) return null
  const list =
    missing.length === 1
      ? missing[0]
      : `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}`
  return `This run needs ${list} before it can start.`
}
