import type { PermissionMode } from '@shared/settings.types'
import type { ToolRisk } from '@shared/tools.types'

/** Whether a guarded tool call should be auto-run or confirmed with the user. */
export type PermissionDecision = 'auto' | 'confirm'

/**
 * Resolve whether a tool call at a given risk level should run automatically
 * or be confirmed, under the active permission mode.
 *
 * - `ask`: confirm everything except trivial, no-risk actions (e.g. `mkdir`).
 * - `full`: safe mutations run automatically; sensitive/destructive actions are confirmed.
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
  /\bchmod\s+-R\s+777\s+\//i
]

/** Classify a shell command's risk for the permission system. */
export function classifyCommandRisk(command: string): ToolRisk {
  return DESTRUCTIVE_COMMAND_PATTERNS.some((pattern) => pattern.test(command))
    ? 'destructive'
    : 'sensitive'
}
