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
 * Written as a sentence — leading capital, a real word before the last item —
 * because it sits in the transcript beside the model's own prose and reads as
 * part of it. It names its subject wherever one call had a single obvious
 * subject ("Edited camera.py", "Ran npm test") and falls back to counting only
 * when there were several.
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
  if (commands.length > 0) parts.push(describeCommands(commands))
  if (web.length > 0) parts.push(describeSearches(web))
  if (reads.length > 0) parts.push(describeReads(reads))

  // Plan bookkeeping is never the interesting part of a turn, so it only
  // speaks up when it is the *only* thing that happened.
  if (parts.length === 0) {
    const plans = settled.filter((call) => call.kind === 'plan')
    return plans.length > 0 ? 'Updated the plan' : null
  }

  const failed = settled.filter((call) => call.status === 'error').length
  const summary = capitalize(joinParts(parts))
  // Surfaced because a failure hidden behind a collapsed header is the one
  // thing a reader would want the header to have told them.
  return failed > 0 ? `${summary} — ${failed} failed` : summary
}

/** Name the file when a turn touched exactly one, count them when it touched several. */
function describeEdits(edits: readonly ToolCall[]): string {
  const paths = uniquePaths(edits)
  if (paths.length === 1) return `edited ${basename(paths[0])}`
  if (paths.length > 1) return `edited ${plural(paths.length, 'file')}`
  return plural(edits.length, 'change')
}

/**
 * Name the command itself when there was one. "Ran the tests" is the sentence a
 * reader wants; "1 command" makes them expand the section to learn which.
 */
function describeCommands(commands: readonly ToolCall[]): string {
  if (commands.length === 1) {
    const command = subjectOf(commands[0].title, 'Run:')
    if (command) return `ran ${shorten(command)}`
  }
  return `ran ${plural(commands.length, 'command')}`
}

function describeSearches(web: readonly ToolCall[]): string {
  if (web.length === 1) {
    const query = subjectOf(web[0].title, 'Search', 'Fetch')
    if (query) return `searched for ${shorten(unquote(query))}`
  }
  return `made ${plural(web.length, 'web search', 'web searches')}`
}

function describeReads(reads: readonly ToolCall[]): string {
  const paths = uniquePaths(reads)
  if (paths.length === 1) return `read ${basename(paths[0])}`
  if (paths.length > 1) return `read ${plural(paths.length, 'file')}`
  return `read ${plural(reads.length, 'file')}`
}

function uniquePaths(calls: readonly ToolCall[]): string[] {
  const paths = new Set<string>()
  for (const call of calls) {
    for (const path of call.touchedPaths ?? []) paths.add(path)
  }
  return [...paths]
}

/**
 * The part of a tool's UI title that names what it acted on. Titles are written
 * for people ("Run: npm test"), so the prefix is the only thing to strip.
 */
function subjectOf(title: string, ...prefixes: readonly string[]): string | null {
  for (const prefix of prefixes) {
    if (title.startsWith(prefix)) {
      const rest = title.slice(prefix.length).trim()
      if (rest.length > 0) return rest
    }
  }
  return null
}

/** Keep a named subject to a glance — the full text is one click away. */
function shorten(text: string, max = 42): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`
}

/** Tool titles quote their subject (`Search "orbit"`); the label does not need to. */
function unquote(text: string): string {
  const trimmed = text.trim()
  return trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 1
    ? trimmed.slice(1, -1)
    : trimmed
}

function basename(path: string): string {
  return path.split('/').pop() ?? path
}

function plural(n: number, singular: string, many = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : many}`
}

/** "a", "a and b", "a, b and c" — the last separator is a word, not a comma. */
function joinParts(parts: readonly string[]): string {
  if (parts.length === 1) return parts[0]
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
