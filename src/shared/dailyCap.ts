/**
 * What a provider's daily token cap does when it is reached.
 *
 * The cap itself already existed and was honest about being decorative — the
 * settings row says "Optional warning threshold. It never blocks a message."
 * It drew a progress bar and nothing else. That is a reasonable default and a
 * poor only option: the reason to set a number on a metered API is usually
 * that you want it to stop, and watching a bar fill up while a runaway agent
 * loop spends money is not a control.
 *
 * So the number stays per provider and the *policy* is one global choice.
 * Two providers wanting different numbers is ordinary; wanting a cap to mean
 * different things on different providers is not, and eleven copies of the
 * same toggle is eleven chances for one of them to be wrong.
 *
 * Off by default, so nothing changes for anyone who already set a cap
 * expecting a warning.
 */

/** A provider's position against its own cap, right now. */
export interface DailyCapState {
  /** Tokens Anodex has sent through this provider today, by its own tally. */
  todayTokens: number
  /** The configured cap, or `null` when there is none. */
  cap: number | null
  /** Whether reaching the cap should refuse the send rather than warn. */
  stopAtCap: boolean
}

/**
 * Whether this send should be refused.
 *
 * Deliberately `>=`: at exactly the cap the budget is spent, and the next
 * send is the one that goes over. A cap that allows one more request after
 * being reached is a cap nobody can reason about.
 *
 * A cap of zero means zero — it refuses everything, which is a legitimate way
 * to turn a provider off for the day. `null` is the way to mean "no cap"; a
 * negative or non-finite value is treated as no cap rather than as a refusal,
 * because refusing everything on a corrupt settings value would look like the
 * provider being broken.
 */
export function dailyCapReached(state: DailyCapState): boolean {
  if (!state.stopAtCap) return false
  if (state.cap === null || !Number.isFinite(state.cap) || state.cap < 0) return false
  return state.todayTokens >= state.cap
}

/**
 * What to tell someone whose send was refused.
 *
 * Names the number they set and the number they are at, because the only
 * useful next actions are "raise it" or "wait", and both need those two
 * figures. Says where the count comes from: it is Anodex's own tally of what
 * it sent, not a balance read from the provider, and someone comparing it
 * against a billing page will otherwise think one of them is lying.
 */
export function dailyCapRefusal(providerLabel: string, state: DailyCapState): string {
  const cap = state.cap ?? 0
  return (
    `${providerLabel} has reached its daily token cap: ` +
    `${state.todayTokens.toLocaleString()} of ${cap.toLocaleString()} tokens used today. ` +
    'Anodex counts what it sends, so this is its own tally rather than a figure from the ' +
    'provider. Raise the cap in Settings → AI & Models → Cloud, switch provider, or wait ' +
    'for the count to reset at midnight.'
  )
}
