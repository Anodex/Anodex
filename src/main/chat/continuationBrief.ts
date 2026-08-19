import type { ToolCall } from '@shared/tools.types'
import {
  hasStaleVisualEvidence,
  isReadLikeCall,
  progressFromSettledCalls
} from '../tools/turnProgress'
import { hasVerificationOfChange, isDurableChange } from './turnSummary'

/**
 * The task's settled state, handed to the model at the top of every
 * continuation cycle.
 *
 * ## Why this exists
 *
 * A bounded reply can run for many provider cycles, and every cycle after the
 * first used to open with one fixed sentence — "continue exactly where you left
 * off" — plus whatever of the transcript still fitted. That is enough context to
 * *know* what happened and not enough to *decide* what to do next, and the
 * difference showed up in a measured 8K run: the model read files 24 times,
 * re-reading the same two repeatedly, made no edit at all, and the reply was
 * eventually stopped for going in circles. It had already found the cause. What
 * it never received was a compact statement that the cause was found, the files
 * were read, and nothing had been changed yet.
 *
 * This is that statement. It is the same idea as `ContextEpochHandoff` — which
 * covers the much rarer case where compaction throws the transcript away — at
 * the frequency the failure actually happens.
 *
 * ## What it may contain
 *
 * Only facts derived from **settled tool calls**: what was changed, what was
 * read, and which verification is outstanding. Never the model's prose about
 * any of those, and never a decision inferred from the user's wording — the
 * same rule the closing account in `turnSummary.ts` follows, for the same
 * reason. A brief that could be wrong would be worse than no brief, because the
 * model has no way to check it.
 */
export interface ContinuationBriefInput {
  /** What this reply is trying to achieve — the standing goal or the user's request. */
  objective: string
  /** Every settled call of this bounded reply so far, in settlement order. */
  calls: ToolCall[]
  /** The active model's window, for sizing. Unknown windows get the middle of the range. */
  contextWindowTokens?: number
}

/** Distinct paths named in the brief before it starts counting instead. */
const MAX_NAMED_PATHS = 6

/**
 * Render the brief, or `null` when nothing has settled yet and there is
 * therefore nothing derived to say.
 */
export function buildContinuationBrief(input: ContinuationBriefInput): string | null {
  const settled = input.calls.filter((call) => call.status !== 'running')
  if (settled.length === 0) return null

  const limit = briefCharBudget(input.contextWindowTokens)
  const changed = pathsOf(settled.filter((call) => isDurableChange(call) && call.kind === 'write'))
  const reads = settled.filter((call) => call.status === 'success' && isReadLikeCall(call))
  const read = pathsOf(reads)

  return fit(
    {
      header:
        'Task state (derived by Anodex from settled tool calls — authoritative, unlike ' +
        'anything said about them above):',
      objective: `Objective: ${truncate(input.objective.trim(), Math.floor(limit / 3))}`,
      changed:
        changed.length > 0
          ? `Changed so far: ${describePaths(changed)}.`
          : 'Changed so far: nothing — this reply has only looked.',
      read:
        reads.length > 0
          ? `Already read (${reads.length} call(s) over ${read.length} file(s)): ` +
            `${describePaths(read)}. Re-read one only if it has changed since.`
          : '',
      outstanding: outstanding(settled),
      instruction:
        'Take the next concrete action toward the objective now, or say plainly what is blocking it.'
    },
    limit
  )
}

/** The brief's lines, in render order. */
interface BriefLines {
  header: string
  objective: string
  changed: string
  read: string
  outstanding: string
  instruction: string
}

/**
 * Shed whole lines, least load-bearing first, until the brief fits.
 *
 * The read list goes first: it is the longest line, and the transcript above
 * usually still holds some of it. The changed list goes next. What is never
 * shed is the objective, the outstanding verification and the instruction —
 * a brief missing those is a header with nothing under it.
 */
function fit(lines: BriefLines, limit: number): string {
  const shedOrder: (keyof BriefLines)[] = ['read', 'changed']
  const kept = { ...lines }
  const render = (): string =>
    [kept.header, kept.objective, kept.changed, kept.read, kept.outstanding, kept.instruction]
      .filter(Boolean)
      .join('\n')

  for (const key of shedOrder) {
    if (render().length <= limit) break
    kept[key] = ''
  }
  return render()
}

/**
 * The one verification the task still owes, in the order that matters.
 *
 * Stale visual evidence first: a change made after the last inspection is the
 * state in which a completion claim is unsupported, and the specific gap the
 * evidence gate in `agentTools.ts` refuses a `finish_goal` for. Then a change
 * nothing has checked at all — the most repeated failure in the benchmark
 * record, and the one an earlier version of this brief was silent about,
 * because "no inspection has ever run" is indistinguishable from "this task has
 * nothing to do with pixels" until you also know something was changed. The
 * gathering case last, because it is advice rather than an obligation.
 */
function outstanding(settled: ToolCall[]): string {
  const progress = progressFromSettledCalls(settled)
  if (hasStaleVisualEvidence(progress)) {
    return (
      'Outstanding: something changed after the last visual inspection, so that inspection no ' +
      'longer proves anything. Look at the result again before reporting success.'
    )
  }
  if (progress.madeChange && !hasVerificationOfChange(settled)) {
    return (
      'Outstanding: nothing has checked the change yet — no build, test or check command has run ' +
      'against it and nothing has looked at the result. Verify it with a tool before reporting it ' +
      'as working; re-reading the file you just edited is not verification.'
    )
  }
  if (!progress.madeChange) {
    const gathering = settled.filter((call) => isReadLikeCall(call)).length
    return (
      `Outstanding: nothing has been changed yet, after ${gathering} information-gathering ` +
      'call(s). More looking is not moving this forward.'
    )
  }
  return ''
}

/** Distinct paths a set of calls touched, most recently touched first. */
function pathsOf(calls: ToolCall[]): string[] {
  const paths: string[] = []
  for (const call of calls.toReversed()) {
    for (const path of call.touchedPaths ?? []) {
      if (!paths.includes(path)) paths.push(path)
    }
  }
  return paths
}

function describePaths(paths: string[]): string {
  const named = paths.slice(0, MAX_NAMED_PATHS)
  const omitted = paths.length - named.length
  return `${named.join(', ')}${omitted > 0 ? `, and ${omitted} more` : ''}`
}

/**
 * What the lines that are never shed cost to render.
 *
 * A floor below this would not make the brief smaller — there is nothing left
 * to drop — it would only make the budget a number the renderer quietly
 * exceeds. `keeps every un-sheddable line inside the floor` in the tests
 * measures this against the real render, so growing the prose fails there
 * rather than silently overrunning here.
 */
const IRREDUCIBLE_BRIEF_CHARS = 520

/**
 * Proportional to the window, like every other protected prompt segment.
 *
 * The ceiling is where naming more files stops adding anything a next action
 * needs; past that the brief would be repeating the transcript above it.
 */
function briefCharBudget(contextWindowTokens: number | undefined): number {
  const context = Math.max(1, contextWindowTokens ?? 16_384)
  return Math.max(IRREDUCIBLE_BRIEF_CHARS, Math.min(900, Math.floor(context * 0.04) * 4))
}

function truncate(value: string, limit: number): string {
  if (limit <= 1) return ''
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`
}
