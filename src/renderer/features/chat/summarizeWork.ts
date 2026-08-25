import type { ToolCall } from '@shared/tools.types'

/**
 * A short, plain description of what a collapsed run of tool calls did.
 *
 * The collapsed header used to read "Work details", which says nothing: the
 * reader has to expand it to learn whether the turn read one file or rewrote
 * six. Everything needed to say so is already on the calls the header hides —
 * their kind, their target, and whether they succeeded.
 *
 * Deliberately derived from the settled record rather than from the model's
 * prose. A summary written by the model could describe work it did not do,
 * which is the whole failure `turnSummary.ts` exists to prevent on the reply
 * itself; the same rule applies to the label above it.
 *
 * Returns `null` when there is nothing worth naming, so the caller can keep its
 * own wording rather than render an empty phrase.
 */
export function summarizeWork(calls: readonly ToolCall[]): string | null {
  const settled = calls.filter((call) => call.status !== 'running')
  if (settled.length === 0) return null

  const edits = settled.filter((call) => call.kind === 'write')
  const commands = settled.filter((call) => call.kind === 'command')
  const web = settled.filter((call) => call.kind === 'web')
  const reads = settled.filter((call) => call.kind === 'read')

  const parts: string[] = []
  // Changes first: what a turn altered matters more than what it looked at.
  if (edits.length > 0) parts.push(describeEdits(edits))
  if (commands.length > 0) parts.push(count(commands.length, 'command'))
  if (web.length > 0) parts.push(count(web.length, 'search', 'searches'))
  if (reads.length > 0) parts.push(`read ${count(reads.length, 'file')}`)

  // Plan bookkeeping is never the interesting part of a turn, so it only
  // speaks up when it is the *only* thing that happened.
  if (parts.length === 0) {
    const plans = settled.filter((call) => call.kind === 'plan')
    if (plans.length > 0) return 'updated the plan'
    return null
  }

  const failed = settled.filter((call) => call.status === 'error').length
  const summary = joinParts(parts)
  // Surfaced because a failure hidden behind a collapsed header is the one
  // thing a reader would want the header to have told them.
  return failed > 0 ? `${summary} · ${failed} failed` : summary
}

/** Name the file when a turn touched exactly one, count them when it touched several. */
function describeEdits(edits: readonly ToolCall[]): string {
  const paths = new Set<string>()
  for (const edit of edits) {
    for (const path of edit.touchedPaths ?? []) paths.add(path)
  }
  if (paths.size === 1) {
    const [only] = [...paths]
    return `edited ${only.split('/').pop() ?? only}`
  }
  if (paths.size > 1) return `edited ${count(paths.size, 'file')}`
  return count(edits.length, 'change')
}

function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`
}

/** "a", "a and b", "a, b and c" — the last separator is a word, not a comma. */
function joinParts(parts: readonly string[]): string {
  if (parts.length === 1) return parts[0]
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}
