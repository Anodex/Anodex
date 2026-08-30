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
 * The reachable cause is a missing goal — including a whitespace-only one,
 * which looks filled in.
 *
 * The budget checks below are defence for programmatic callers, **not** a path
 * a user can take. An earlier version of this comment claimed a cleared budget
 * field was the cause, on the reasoning that `Number('')` is `0`; that is true
 * of a number input and these are `RangeControl` sliders with a minimum of 1
 * and a clamped seed, so a budget cannot reach a blocking value from the form
 * at all. The checks are kept because `NaN` and `0` still fail correctly if a
 * caller ever supplies them, and costing nothing is a poor reason to remove a
 * correct check — but the claim was wrong and is corrected here rather than
 * left to mislead.
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
