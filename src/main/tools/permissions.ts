import type { PermissionMode } from '@shared/settings.types'
import type { ToolRisk } from '@shared/tools.types'
import { isReadOnlyCommand } from './readOnlyCommand'

/** Whether a guarded tool call should be auto-run or confirmed with the user. */
export type PermissionDecision = 'auto' | 'confirm'

/**
 * Resolve whether a tool call at a given risk level should run automatically
 * or be confirmed, under the active permission mode.
 *
 * - `ask`: confirm everything except trivial, no-risk actions (e.g. `mkdir`).
 * - `full` (shown as Edits): file edits and read-only commands run automatically; other
 *   commands and destructive actions are confirmed.
 * - `untethered`: safe and sensitive actions run automatically; destructive actions are
 *   still confirmed, so the assistant can't be talked into wiping the disk unattended.
 */
export function resolvePermission(mode: PermissionMode, risk: ToolRisk): PermissionDecision {
  if (risk === 'trivial') return 'auto'
  if (mode === 'ask') return 'confirm'
  if (risk === 'destructive') return 'confirm'
  if (mode === 'full' && risk === 'sensitive') return 'confirm'
  return 'auto'
}

/**
 * Whether a call needs the once-per-turn "first action" gate, on top of
 * `resolvePermission`'s own risk-based decision. Applies only to `full` —
 * the mode where a risk tier (`safe`) silently auto-runs but the user still
 * wants a single per-turn heads-up before that starts. `untethered` is meant
 * to run with almost no prompts, so it skips this gate entirely and relies
 * solely on `resolvePermission` (which still confirms `destructive` every
 * time). Never relevant for `ask`, since every non-trivial call already
 * confirms there — nothing left to gate.
 */
export function needsTurnGate(
  mode: PermissionMode,
  risk: ToolRisk,
  turnGateApproved: boolean
): boolean {
  return (
    mode === 'full' &&
    risk !== 'trivial' &&
    resolvePermission(mode, risk) !== 'confirm' &&
    !turnGateApproved
  )
}

/**
 * A recursive *and* forced delete, in any spelling and either order: bundled
 * (`rm -rf`), separate (`rm -r -f`), reversed (`rm -f -r`), long
 * (`rm --recursive --force`), or mixed. Two independent lookaheads rather than
 * one pattern per ordering, which is what the hand-written pairs below used to
 * be — and they covered only half of it. `rm -f -r`, `rm --recursive --force`
 * and every mixed spelling classified as merely `sensitive`, which auto-runs
 * with nobody watching.
 *
 * `[^\r\n|;&]*` keeps each lookahead inside a single command, so the `-f` in
 * `rm -r dist | grep -f pattern` does not complete the pair. Both flags must be
 * present: `rm -r` or `rm -f` alone is not what this tier is for.
 */
function recursiveForcedDelete(command: string, recursive: string, force: string): RegExp {
  const near = String.raw`[^\r\n|;&]*\s`
  return new RegExp(String.raw`\b${command}\b(?=${near}${recursive}\b)(?=${near}${force}\b)`, 'i')
}

/** Patterns that mark a shell command as destructive regardless of permission mode. */
const DESTRUCTIVE_COMMAND_PATTERNS: RegExp[] = [
  recursiveForcedDelete(
    'rm',
    String.raw`(?:--recursive|-\w*r\w*)`,
    String.raw`(?:--force|-\w*f\w*)`
  ),
  // PowerShell accepts any unambiguous prefix of a parameter name, so `-rec`
  // and `-fo` are the same command as `-Recurse -Force` and were not matched.
  recursiveForcedDelete('remove-item', String.raw`-r\w*`, String.raw`-f\w*`),
  /\brd\s+\/s\b/i, // rd /s
  /\brmdir\s+\/s\b/i, // rmdir /s
  /\bdel\s+(\/[a-z]\s*)*\/s\b/i, // del ... /s
  /\bformat\s+[a-z]:/i, // format c:
  /\bdiskpart\b/i,
  /\bgit\s+push\b.*(--force|-f)\b/i,
  /\bgit\s+push\b[^|;&\n]*\s\+\S/i, // git push origin +main (force-push via refspec)
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-\w*f/i,
  />\s*\/dev\/(sd|nvme|disk)/i,
  /\bdrop\s+(table|database|schema)\b/i,
  /\bshutdown\b/i,
  /\bmkfs\b/i,
  /\bchmod\s+-R\s+777\s+\//i,
  // Discarding the working tree, which `git reset --hard` and `git clean -f`
  // above already put in this tier. Scoped to a bare `--` or `.` so that
  // switching branches - `git checkout main`, `git checkout -b x`,
  // `git checkout --track ...` - stays ordinary and does not start demanding
  // confirmation on every normal workflow.
  /\bgit\s+checkout\s+(?:--\s|\.)/i,
  // `git restore` restores the working tree by default. `--staged` alone only
  // unstages, which the index and the object store both survive.
  /\bgit\s+restore\b(?![^\r\n|;&]*--staged\b)/i,
  // The same act as the `> /dev/sd` redirect above, in dd's own syntax.
  /\bdd\b[^\r\n|;&]*\sof=\/dev\//i,
  // Emptying the Trash is the one delete nothing can undo: everything else
  // Anodex removes goes there precisely so it can be put back. Measured: asked
  // to "empty my Trash", an 8B ran `gio trash --empty` with no question asked.
  /\bgio\s+trash\b[^\r\n|;&]*--empty\b/i,
  /\btrash-empty\b/i,
  /\bClear-RecycleBin\b/i,
  /\bosascript\b[^\r\n]*\bempty\s+(?:the\s+)?trash\b/i,
  /\b(?:rm|remove-item|del|rd|rmdir)\b[^\r\n|;&]*(?:\.local[\\/]share[\\/]Trash|~[\\/]\.Trash|\$Recycle\.Bin)/i
]

/**
 * Classify a shell command's risk for the permission system.
 *
 * A command that only reads is `safe`, the tier file edits are in: Edits mode runs it
 * without asking, and Ask mode still asks. See `isReadOnlyCommand`.
 */
export function classifyCommandRisk(command: string): ToolRisk {
  if (DESTRUCTIVE_COMMAND_PATTERNS.some((pattern) => pattern.test(command))) return 'destructive'
  if (isJustPrinting(command)) return 'trivial'
  return isReadOnlyCommand(command) ? 'safe' : 'sensitive'
}

/**
 * `echo` or `printf` and nothing else: no redirect, pipe, chaining, substitution
 * or expansion beyond a plain variable — text in, the same text out.
 *
 * Small models answer ordinary questions through the shell ("echo 'Canberra'"):
 * Llama 3.1 8B did it for every fact, sum and synonym it was asked, and in Ask
 * mode each one stopped for approval before the answer appeared. Nothing about
 * such a command can change anything, so it runs the way `create_directory` does,
 * without asking in any mode.
 */
function isJustPrinting(command: string): boolean {
  const trimmed = command.trim()
  if (!/^(?:echo|printf|Write-Output|Write-Host)\b/i.test(trimmed)) return false
  // Anything that could write a file, run something else, or substitute a command.
  return !/[>|;&`\n]|\$\(|<\(|\$\{[^}]*[:=!]/.test(trimmed)
}
