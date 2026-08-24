import type { Plan } from '@shared/plan.types'
import type { ToolCall } from '@shared/tools.types'
import { isObservationalRunCommand } from '../tools/commandEffect'
import { parseRunCommandVerification } from '../tools/commandTools'
import type { PathClaimIssue } from '../tools/pathClaimVerification'

/**
 * The closing account of a reply, rendered from what actually settled.
 *
 * ## Why this is not left to the model
 *
 * A reply is supposed to end by telling the user what it did. On a small local
 * model it very often does not: it stops mid-intent, or has its last calls
 * refused by a guard, and the user is left with fragments of narration and a
 * stack of disclaimers. Eleven live runs of one request produced a proper
 * closing summary twice.
 *
 * Anodex does not need the model for this. Every settled call carries its name,
 * kind, status and touched paths, so what a turn changed, ran, looked at and
 * left open is already known — and a summary derived from that record has a
 * property a model-written one does not: **it cannot be wrong.** One live reply
 * described a rendered scene in confident detail ("the Sun glowing brightly…
 * all 8 planets orbiting") having never once called `inspect_visual`.
 *
 * ## Why it replaced six separate notes
 *
 * Build verification, visual verification, unverified paths, open plan rows,
 * "nothing changed", "stopped for going in circles" — each was appended
 * independently, so a bad turn ended in a wall of warnings with no statement of
 * what had happened. They are all facts about the same turn and belong in one
 * account, with the work first and the caveats after it.
 */
export interface TurnSummaryInput {
  /** Every settled call of the whole bounded reply, in settlement order. */
  calls: ToolCall[]
  /** The conversation's plan, if it has one. */
  plan: Plan | null | undefined
  /** Whether the turn ended on a stop that renders its own banner. */
  stopped: boolean
  /** Gathering calls the task ledger refused — see `TaskLedger.blockedGathering`. */
  blockedGathering: number
  /** Paths the reply named but never touched — see `findUnverifiedPathClaims`. */
  unverifiedPaths: PathClaimIssue[]
  /**
   * Why the turn stopped continuing when it wanted to keep going — see
   * `describeChatStop`. `null` when it simply finished answering.
   */
  endedBecause?: string | null
}

/** Tool kinds that can change the workspace. */
const MUTATING_TOOL_KINDS = new Set(['write', 'command'])

/**
 * Whether one settled call actually changed something.
 *
 * A successful shell command that only looked at a file is excluded: the point
 * of `isObservationalRunCommand` is that `run_command`'s kind describes the
 * tool, not the effect.
 */
export function isDurableChange(call: ToolCall): boolean {
  return (
    call.status === 'success' &&
    call.madeProgress !== false &&
    MUTATING_TOOL_KINDS.has(call.kind) &&
    !isObservationalRunCommand(call)
  )
}

/**
 * Render the closing account, or `null` when the reply used no tools at all —
 * an ordinary conversational answer has nothing to report.
 */
export function describeTurnOutcome(input: TurnSummaryInput): string | null {
  const caveats = describeCaveats(input)

  // A reply that called no tools normally has nothing to report. The exception
  // is a caveat: a turn that did no work and *still* cited files by name is the
  // fabrication case this account exists to catch, so it is the one zero-call
  // turn that must not stay silent. (Regression: a live synthesis cycle made
  // zero calls and cited four nonexistent paths in a confident-looking table.)
  if (input.calls.length === 0) {
    return caveats === null ? null : `${HEADING}\n\n- ${caveats}`
  }

  const lines = [
    describeChanges(input.calls),
    describeVerification(input.calls),
    describeInspection(input.calls),
    describePlan(input.plan),
    describeEnding(input),
    caveats
  ].filter((line): line is string => line !== null)

  if (lines.length === 0) return null
  return `${HEADING}\n\n${lines.map((line) => `- ${line}`).join('\n')}`
}

/** Separated from the reply's own prose, so the account is never mistaken for it. */
const HEADING = '\n\n---\n**What this reply did**'

/** Files written, grouped by path, newest count first. */
function describeChanges(calls: ToolCall[]): string {
  const edits = new Map<string, number>()
  for (const call of calls) {
    if (!isDurableChange(call) || call.kind !== 'write') continue
    for (const path of call.touchedPaths ?? [call.title]) {
      edits.set(path, (edits.get(path) ?? 0) + 1)
    }
  }
  if (edits.size === 0) return '**Changed** nothing — this reply only looked.'
  const rendered = [...edits.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([path, count]) => (count > 1 ? `\`${path}\` (${count} edits)` : `\`${path}\``))
  const omitted = edits.size - rendered.length
  return `**Changed** ${rendered.join(', ')}${omitted > 0 ? `, and ${omitted} more` : ''}`
}

/**
 * What was actually run against the change, which is the difference between a
 * fix and a proposal.
 */
function describeVerification(calls: ToolCall[]): string | null {
  const verifications = calls
    .map((call) => parseRunCommandVerification(call))
    .filter(
      (verification): verification is NonNullable<typeof verification> => verification !== null
    )
    .filter((verification) => isVerificationCommand(verification.command))

  if (verifications.length === 0) {
    if (!calls.some(isDurableChange)) return null
    // A page has no build. Reporting a change that was screenshotted after the
    // fact as "not verified" is the same false accusation as calling a green
    // `cargo test` unverified — and it lands on exactly the projects, static
    // sites, that have no command to run in the first place.
    if (hasVisualEvidenceOfChange(calls)) {
      return '**Verified** visually — the screenshot was taken after the last change'
    }
    return '**Not verified** — no build, test, type-check or lint command ran against the change'
  }

  // Keep the last outcome per command: a turn that fixed a failing build ran it
  // twice, and reporting the first result would describe a fix as broken.
  const latest = new Map<string, 'passed' | 'failed'>()
  for (const { command, status } of verifications) latest.set(command, status)

  const rendered = [...latest.entries()]
    .slice(-3)
    .map(([command, status]) => `\`${command}\` ${status}`)
  // A failing build is the single most useful thing a turn can report, so it
  // must not hide inside a line that opens with the word "Verified".
  const anyFailed = [...latest.values()].includes('failed')
  return `${anyFailed ? '**Ran**' : '**Verified**'} ${rendered.join(', ')}`
}

/**
 * Which files the reply actually examined, and how much work that took.
 *
 * Named rather than merely counted. "48 file reads" tells the user how busy the
 * turn was; the file names tell them *what it found its way to*, which is the
 * part they can check against their own understanding of the problem — and on a
 * turn that was cut short before writing any conclusions, it is the only
 * account of where the work got to.
 */
function describeInspection(calls: ToolCall[]): string | null {
  const succeeded = (names: string[]): ToolCall[] =>
    calls.filter((call) => names.includes(call.name) && call.status === 'success')

  const examined = new Set<string>()
  for (const call of succeeded([
    'read_file',
    'read_file_range',
    'read_multiple_files',
    'code_outline',
    'inspect_visual'
  ])) {
    for (const path of call.touchedPaths ?? []) examined.add(path)
  }

  const effort: string[] = []
  const reads = succeeded(['read_file', 'read_file_range', 'read_multiple_files', 'code_outline'])
  const searches = succeeded(['search_files', 'search_code', 'find_files', 'list_directory'])
  const shots = succeeded(['inspect_visual'])
  if (reads.length > 0) effort.push(`${reads.length} read${reads.length === 1 ? '' : 's'}`)
  if (searches.length > 0) {
    effort.push(`${searches.length} search${searches.length === 1 ? '' : 'es'}`)
  }
  if (shots.length > 0) effort.push(`${shots.length} screenshot${shots.length === 1 ? '' : 's'}`)
  if (effort.length === 0) return null

  const named = [...examined].slice(0, 6)
  const omitted = examined.size - named.length
  const where =
    named.length > 0
      ? ` in ${named.map((path) => `\`${path}\``).join(', ')}${omitted > 0 ? ` and ${omitted} more` : ''}`
      : ''
  return `**Looked at** ${effort.join(', ')}${where}`
}

function describePlan(plan: Plan | null | undefined): string | null {
  if (!plan || plan.steps.length === 0) return null
  const open = plan.steps.filter((step) => step.status !== 'completed')
  const done = plan.steps.length - open.length
  if (open.length === 0) return `**Plan** all ${plan.steps.length} steps complete`
  return (
    `**Plan** ${done} of ${plan.steps.length} steps complete — still open: ` +
    open
      .slice(0, 4)
      .map((step) => step.title)
      .join('; ')
  )
}

/**
 * Why the reply ended, when it ended for a reason the user cannot otherwise
 * see. A turn that stopped for a reason with its own banner is left alone, so
 * one outcome never carries two explanations.
 */
function describeEnding(input: TurnSummaryInput): string | null {
  // A turn that stopped used to be left alone here, on the reasoning that its
  // own banner already explained the ending and two explanations are worse than
  // one. A live run disproved it: ten gathering calls were refused, the reply
  // broke off mid-sentence at "Let me verify the actual files in the js
  // directory", and nothing anywhere told the user why. The banner does not
  // reach them. A rare duplicate explanation costs a line; a silent stop costs
  // the user the whole account of what happened.
  //
  // The ladder refusing calls is the more specific cause, so it wins over the
  // loop's own account of running out of rounds.
  if (input.blockedGathering > 0) {
    return (
      `**Ended early** — ${input.blockedGathering} further information-gathering call(s) were ` +
      'refused because it had gone a long stretch without changing anything. Say "continue" to resume.'
    )
  }
  if (input.endedBecause) return `**Ended early** — ${input.endedBecause}`
  return null
}

/** Claims the settled record does not support. */
function describeCaveats(input: TurnSummaryInput): string | null {
  const caveats: string[] = []

  const missing = input.unverifiedPaths.filter((issue) => issue.reason === 'not-found')
  const untouched = input.unverifiedPaths.filter((issue) => issue.reason === 'not-inspected')
  if (missing.length > 0) {
    caveats.push(
      `this reply named ${missing.map((issue) => `\`${issue.path}\``).join(', ')}, which ${missing.length === 1 ? 'does' : 'do'} not exist here (likely fabricated or misspelled)`
    )
  }
  if (untouched.length > 0) {
    caveats.push(
      `mentioned ${untouched.map((issue) => `\`${issue.path}\``).join(', ')} without opening ${untouched.length === 1 ? 'it' : 'them'} this task`
    )
  }
  if (hasStaleVisualEvidence(input.calls)) {
    caveats.push(
      'the last change came after the most recent screenshot, so nothing here shows it — ' +
        'call inspect_visual again, using its sectionId for the specific section in question'
    )
  }

  return caveats.length > 0 ? `**Check** ${caveats.join('; ')}` : null
}

/**
 * Whether anything at all has checked the newest change.
 *
 * A build/test/type-check/lint command that ran after it, or a screenshot taken
 * after it. Exported so the continuation brief can tell the model the same
 * thing mid-task that this account tells the user at the end — a live 16K run
 * made five successful edits, said "let me inspect the visual result", never
 * called the tool, and closed by reporting the fix as working. The account
 * below caught it; nothing had told the model while it could still act.
 */
export function hasVerificationOfChange(calls: ToolCall[]): boolean {
  // A check command is a `command`-kind call, so it is a durable change by the
  // same rule — and measuring "after the last change" naively would mean a
  // build could never count as verifying anything, because it would always be
  // the last change itself. The change that needs checking is the last one that
  // is not a check.
  const lastChange = calls.findLastIndex((call) => isDurableChange(call) && !isCheckCommand(call))
  if (lastChange < 0) return true
  return calls.some(
    (call, index) =>
      index > lastChange &&
      (isCheckCommand(call) || (call.name === 'inspect_visual' && call.status === 'success'))
  )
}

/** A successful build/test/type-check/lint run, as opposed to any other command. */
function isCheckCommand(call: ToolCall): boolean {
  const verification = parseRunCommandVerification(call)
  return verification !== null && isVerificationCommand(verification.command)
}

/** Whether a screenshot was taken after the last change, and so shows it. */
function hasVisualEvidenceOfChange(calls: ToolCall[]): boolean {
  const lastChange = calls.findLastIndex(isDurableChange)
  if (lastChange < 0) return false
  const lastShot = calls.findLastIndex(
    (call) => call.name === 'inspect_visual' && call.status === 'success'
  )
  return lastShot > lastChange
}

/**
 * Whether the reply holds a screenshot that a later change invalidated.
 *
 * A turn that never inspected anything is not a task about pixels and is left
 * alone; one that looked and *then* changed something has not seen the result.
 */
function hasStaleVisualEvidence(calls: ToolCall[]): boolean {
  const lastChange = calls.findLastIndex(isDurableChange)
  if (lastChange < 0) return false
  const lastShot = calls.findLastIndex(
    (call) => call.name === 'inspect_visual' && call.status === 'success'
  )
  return lastShot >= 0 && lastShot < lastChange
}

/**
 * Commands that count as having actually built, tested, type-checked or linted
 * something, across every ecosystem Anodex might be pointed at.
 *
 * Getting this list wrong is not cosmetic: a C++ developer whose `make test`
 * passed, or a Ruby developer whose `rspec` ran green, would be told their
 * verified fix was unverified — Anodex's own honesty machinery producing a
 * false accusation, and only for non-JavaScript projects. Erring toward
 * inclusion is right: a false negative misinforms, a false positive merely
 * omits a note.
 */
const BUILD_OR_TEST_TOOLS = [
  // JavaScript / TypeScript
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'npx',
  'deno',
  'vitest',
  'jest',
  'mocha',
  'jasmine',
  'playwright',
  'cypress',
  'tsc',
  'eslint',
  'biome',
  // Python
  'pytest',
  'unittest',
  'tox',
  'nox',
  'mypy',
  'pyright',
  'ruff',
  'pylint',
  'flake8',
  'poetry',
  'hatch',
  // Rust
  'cargo',
  'rustc',
  'clippy',
  // Go
  'go',
  'gofmt',
  'golangci-lint',
  // JVM
  'gradle',
  'gradlew',
  'mvn',
  'maven',
  'ant',
  'sbt',
  'lein',
  // .NET
  'dotnet',
  'msbuild',
  'nunit',
  'xunit',
  // C / C++ and general native build systems
  'make',
  'cmake',
  'ctest',
  'ninja',
  'meson',
  'bazel',
  'buck',
  'clang',
  'gcc',
  // Apple platforms
  'swift',
  'xcodebuild',
  'xcrun',
  // Ruby
  'rake',
  'rspec',
  'minitest',
  'bundle',
  // PHP
  'composer',
  'phpunit',
  'pest',
  // Dart / Flutter
  'dart',
  'flutter',
  // Others
  'zig',
  'mix',
  'stack',
  'cabal',
  'nimble',
  'crystal',
  'scons'
]

/**
 * An interpreter running one of the project's own scripts, e.g.
 * `python _smoke_test.py` or `node check.mjs`.
 *
 * The named-tool list cannot cover this. A project with no test framework
 * verifies itself by running its own script, and for many small projects that
 * is the only check there is. Measured: a turn ran `python _smoke_test.py` to a
 * green exit and was still told "**Not verified** — no build, test, type-check
 * or lint command ran", the exact false accusation that list exists to prevent,
 * only for a plain-Python project instead of a C++ one. The same predicate
 * feeds `hasVerificationOfChange`, so the continuation brief was also telling
 * the model mid-task to go and verify what it had just verified.
 *
 * A script *file* is required, which is why this is separate from the word list
 * rather than a bare `python` added to it. Models routinely use `python -c` to
 * read things — this very turn ran `python -c "lines=open('ui.py')..."` — and
 * counting that as proof the change works would turn a missing note into a
 * false claim of verification, which is the worse direction for an honesty
 * feature to fail in.
 */
const SCRIPT_RUN_COMMAND = new RegExp(
  // Flags are allowed before the script (`python -u run.py`) except `-c`, whose
  // argument is code rather than a file.
  String.raw`\b(?:python3?|py|node|ruby|perl|php|Rscript|julia)\s+(?:-[^c\s]\S*\s+)*\S+\.(?:py|js|mjs|cjs|rb|pl|php|R|jl)\b`,
  'i'
)

/** Whether a shell command is something that actually checks the change. */
export function isVerificationCommand(command: string): boolean {
  return BUILD_OR_TEST_COMMAND.test(command) || SCRIPT_RUN_COMMAND.test(command)
}

/**
 * `clang++`/`g++` are matched separately: `+` is not a word character, so a
 * trailing word boundary after them would never match.
 */
const BUILD_OR_TEST_COMMAND = new RegExp(
  // String.raw, not a plain template literal: `\b` in a normal template literal
  // is the backspace escape, so the pattern would silently lose every word
  // boundary and match substrings inside unrelated words.
  String.raw`(?:\b(?:${BUILD_OR_TEST_TOOLS.join('|')})\b|\b(?:clang|g)\+\+)`,
  'i'
)
