import type { ToolRuntimeContext } from './types'

/**
 * Which tools this run can actually call.
 *
 * Two fields decide it and they mean different things: `disabledTools` is what
 * the user switched off for normal chats, and `enabledTools` is an explicit
 * allow-list used by scheduled tasks and agent runs, where the user opts a
 * specific subset into unattended work. `null` there means no restriction.
 *
 * This exists because guidance kept naming tools the run did not have.
 * `edit_file`, when its `oldText` does not match, tells the model to fall back
 * to `replace_lines`; `write_file`, when a rewrite would discard most of a
 * file, names `replace_lines` and `patch_file`. An agent run whose tool list
 * is only the nine reading-and-writing basics has none of them, so the advice
 * costs a round to discover as useless and the model falls back to whatever it
 * would have done anyway. It happened twenty-two times across eleven runs of
 * one benchmark before anything reported it, because a failed edit followed by
 * a re-read looks like ordinary model error.
 *
 * This is the second bug of exactly this shape — the first was a guard that
 * refused the very tool its own message told the model to use. Hence a shared
 * check rather than another one-off fix: anything that names a tool in prose
 * aimed at the model should ask here first.
 */
export function toolIsAvailable(
  ctx: Pick<ToolRuntimeContext, 'enabledTools' | 'disabledTools'>,
  name: string
): boolean {
  if (ctx.disabledTools.has(name)) return false
  return ctx.enabledTools === null || ctx.enabledTools.has(name)
}

/** The subset of `names` this run can call, in the order given. */
export function availableTools(
  ctx: Pick<ToolRuntimeContext, 'enabledTools' | 'disabledTools'>,
  names: readonly string[]
): string[] {
  return names.filter((name) => toolIsAvailable(ctx, name))
}

/**
 * Join tool names for a sentence: "a", "a or b", "a, b or c".
 *
 * Returns '' for none, which is the case the callers have to handle — the
 * whole point is that a clause naming no tools should not be written at all.
 */
export function listToolNames(names: readonly string[]): string {
  if (names.length === 0) return ''
  if (names.length === 1) return names[0]
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`
}
