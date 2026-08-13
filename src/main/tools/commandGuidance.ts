/**
 * Platform and syntax guidance for `run_command`.
 *
 * ## Why this exists
 *
 * In chat `c_fa3b6587-d9f0-430b-9dde-0d8e5a0593ef` the model ran five searches
 * whose results it then reasoned from — and all five were wrong:
 *
 * ```
 * findstr /n "sandbox-container\|sandboxCanvas\|sim-controls" "index.html"   exit 1, no output
 * findstr /n "getElementById\|querySelector" "js\universe-sandbox.js"        exit 1, no output
 * findstr /n "section\|sandbox\|3D\|canvas" "index.html"                     exit 1, no output
 * ```
 *
 * `\|` is *grep* alternation. `findstr` has no such syntax, so it searched for
 * one long literal, found nothing, and exited quietly. Every one of those
 * identifiers exists in the file. Anodex handed the model fabricated evidence
 * and let it draw conclusions from it.
 *
 * The lesson generalizes past this one flag: **a search command that produces
 * no output is ambiguous**. It means "no matches" or "your pattern was wrong",
 * and those are very different facts. Reporting the ambiguity is the fix.
 */

/** Shells where Unix coreutils are not on PATH by default. */
const WINDOWS_NATIVE_SHELL = /(?:^|[\\/])(?:cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?)$/i

/** Shells that do provide Unix coreutils, even on Windows (Git Bash, WSL, MSYS). */
const POSIX_SHELL = /(?:^|[\\/])(?:ba|z|k|da|)sh(?:\.exe)?$/i

/**
 * Unix commands with no Windows-native equivalent, and what to use instead.
 * Deliberately limited to commands that are *certainly* absent and have a
 * direct replacement — a wrong entry here blocks a command that would have
 * worked, so the bar for inclusion is high.
 */
const WINDOWS_ALTERNATIVES: Record<string, string> = {
  grep: "Select-String -Path '<file>' -Pattern '<regex>'",
  sed: "(Get-Content '<file>') -replace '<pattern>','<replacement>'",
  awk: "Get-Content '<file>' | ForEach-Object { ($_ -split '\\s+')[<n>] }",
  ls: 'Get-ChildItem',
  cat: "Get-Content '<file>'",
  head: "Get-Content '<file>' -TotalCount <n>",
  tail: "Get-Content '<file>' -Tail <n>",
  which: '(Get-Command <name>).Source',
  touch: "New-Item -ItemType File '<file>'",
  wc: "(Get-Content '<file>' | Measure-Object -Line).Lines"
}

/** Commands whose empty output is ambiguous between "no matches" and "bad pattern". */
const SEARCH_COMMANDS = /(?:^|[|;&\s])(findstr|grep|egrep|fgrep|rg|ag|ack|select-string)\b/i

/**
 * Whether a command can run in the active shell, and what to run instead if
 * not. Returns null when the command is fine.
 *
 * Only fires for a Windows-native shell. A POSIX shell on Windows (Git Bash,
 * WSL) genuinely provides these commands, and blocking them there would be a
 * false rejection.
 */
export function checkCommandCompatibility(
  command: string,
  platform: NodeJS.Platform,
  shell: string | undefined
): string | null {
  const syntaxProblem = checkSearchSyntax(command)
  if (syntaxProblem) return syntaxProblem

  if (platform !== 'win32') return null
  if (shell && POSIX_SHELL.test(shell)) return null
  if (shell && !WINDOWS_NATIVE_SHELL.test(shell)) return null

  const executable = leadingExecutable(command)
  if (!executable) return null
  const alternative = WINDOWS_ALTERNATIVES[executable]
  if (!alternative) return null

  return (
    `"${executable}" is not available in this shell (Windows ${shell ? `\`${shell}\`` : 'cmd/PowerShell'}). ` +
    `Nothing was run. Use this instead:\n\n  ${alternative}\n\n` +
    'If the tool really is installed, invoke it by its full path.'
  )
}

/**
 * Catch pattern syntax that is silently wrong rather than loudly wrong.
 *
 * `findstr` with `\|` is the case that caused real damage: it does not error,
 * it just reports nothing, which reads exactly like "the identifier is absent."
 */
function checkSearchSyntax(command: string): string | null {
  if (!/(?:^|[|;&\s])findstr\b/i.test(command)) return null
  if (!command.includes('\\|')) return null

  return (
    '`findstr` does not support `\\|` alternation — that is grep syntax. Nothing was run, ' +
    'because findstr would have searched for one long literal, found nothing, and exited ' +
    'quietly, which is indistinguishable from "no matches".\n\n' +
    'Use one of:\n' +
    '  findstr /r /c:"pattern1" /c:"pattern2" "<file>"\n' +
    "  powershell -Command \"Select-String -Path '<file>' -Pattern 'pattern1|pattern2'\""
  )
}

/**
 * The executable a command line starts with, lowercased and stripped of any
 * path or extension. Returns null when the line starts with something that is
 * not a plain command (a variable assignment, a subshell, a redirect).
 */
function leadingExecutable(command: string): string | null {
  const match = /^\s*([A-Za-z][\w.\-\\/]*)/.exec(command)
  if (!match) return null
  const last = match[1].split(/[\\/]/).pop() ?? match[1]
  return last.replace(/\.(?:exe|cmd|bat|ps1)$/i, '').toLowerCase()
}

/**
 * A note appended to a search command that returned nothing, so the model
 * cannot read silence as proof of absence.
 *
 * Returns null for non-search commands and for searches that did produce
 * output — there is nothing ambiguous about those.
 */
export function describeEmptySearchResult(
  command: string,
  output: string,
  terminated: boolean
): string | null {
  if (terminated) return null
  if (!SEARCH_COMMANDS.test(command)) return null
  if (output.trim() && output.trim() !== '(no output)') return null

  return (
    '\n\nNote: this search produced no output. That means EITHER the pattern genuinely does not ' +
    'occur, OR the pattern syntax is wrong for this tool. Do not conclude the term is absent ' +
    'from a single empty result — confirm with a different tool (search_files, code_outline) or ' +
    'a simpler literal pattern before relying on it.'
  )
}
