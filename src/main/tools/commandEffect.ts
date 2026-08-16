/**
 * Deterministic task-effect classification for shell commands.
 *
 * `run_command` remains approval-gated exactly as before. This module answers a
 * different question after execution: did the command change/verify something,
 * or did it only inspect data? Treating every successful `Get-Content` as a
 * mutation let read loops satisfy action-completion and recovery-progress
 * gates even though no workspace state changed.
 */

const MUTATION_RE =
  /(?:^|[\s;&|])(?:Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|New-Item|Rename-Item|Clear-Content|Invoke-WebRequest|Start-Process|Stop-Process|Install-Module|Update-Module)\b|(?:^|\s)(?:>>?|2>)\s*|\bgit\s+(?:add|commit|checkout|switch|reset|restore|clean|merge|rebase|cherry-pick|push|pull)\b/i

/**
 * Commands whose whole job is to look at something.
 *
 * The Unix text utilities are here because a model told to stop reading will
 * reach for whichever one is available. A live run used `sed -n '40,50p'`,
 * `head … | tail -n 30`, and `Select-String` interchangeably for the same job;
 * the ones missing from this list counted as productive work and reset the
 * ledger's gathering ladder, which is how that run got twenty-two free reads
 * out of a guard that had already told it to stop. `sed -i` is excluded by
 * `SHELL_MUTATION_RE` below — in-place editing is the one form of `sed` that
 * writes.
 */
const DIRECT_READ_RE =
  /^(?:Get-Content|Select-String|Get-ChildItem|Get-Item|Get-Location|Get-Command|Test-Path|Resolve-Path|Measure-Object|rg|grep|findstr|ls|dir|type|cat|head|tail|pwd|where(?:\.exe)?|which|sed|awk|nl|wc|cut|uniq|od|xxd|strings|stat|file|basename|dirname|du|less|more)\b|^git\s+(?:status|diff|log|show|branch|rev-parse)\b/i

/** Read-shaped utilities invoked in a mode that writes. */
const SHELL_MUTATION_RE = /\bsed\b[^|;&]*\s-\S*i\b/i

const POWERSHELL_READ_TOKEN_RE =
  /\b(?:Get-Content|Select-String|Get-ChildItem|Get-Item|Get-Location|Get-Command|Test-Path|Resolve-Path|Measure-Object)\b/i

const NON_READ_POWERSHELL_VERB_RE =
  /\b(?:Export|Import|Invoke|Save|Start|Stop|Restart|Install|Uninstall|Update|Enable|Disable|Register|Unregister)-[A-Za-z]+\b/i

export function isObservationalCommand(command: string): boolean {
  // Checked before the mutation patterns, which claim `Start-Process` wholesale.
  if (BROWSER_LAUNCH_RE.test(command)) return true
  if (MUTATION_RE.test(command) || SHELL_MUTATION_RE.test(command)) return false
  const effective = unwrapPowerShellCommand(command)
  const ungrouped = effective.replace(/^\s*[(&{]+\s*/, '')
  if (DIRECT_READ_RE.test(ungrouped)) return true
  return POWERSHELL_READ_TOKEN_RE.test(effective) && !NON_READ_POWERSHELL_VERB_RE.test(effective)
}

/**
 * Opening a URL in the user's browser.
 *
 * `MUTATION_RE` claims `Start-Process` unconditionally, which is right for
 * `Start-Process npm -ArgumentList build` and wrong for
 * `Start-Process "http://localhost:8000/index.html"`. The second changes
 * nothing, gathers nothing, and produces no evidence — but scoring it as a
 * mutation let it reset the ledger's gathering streak, the same shape of hole
 * as the `sed`/`awk` gap: a call that advances the task by nothing being
 * counted as work.
 *
 * Reported as observational because every consumer asks the same question of
 * it — did this call move the task forward? — and for a browser launch the
 * answer is no.
 */
const BROWSER_LAUNCH_RE =
  /^(?:Start-Process|start|explorer|open|xdg-open|cmd(?:\.exe)?\s+\/c\s+start)\b[^|;&]*https?:\/\//i

/** Stable identity for differently-spelled reads of the same evidence. */
export function observationalCommandIdentity(command: string): string {
  const effective = unwrapPowerShellCommand(command)
  const normalized = effective.replace(/\\/g, '/').replace(/\s+/g, ' ').trim().toLowerCase()
  const contentPath = normalized.match(
    /\bget-content\s+(?:(?:-literalpath|-path)\s+)?["']?([^\s"'|;,)]+)/
  )?.[1]
  if (contentPath) {
    const skip = numberAfter(normalized, /\bselect-object\s+-skip\s+(\d+)/) ?? 0
    const first =
      numberAfter(normalized, /\bselect-object(?:\s+-skip\s+\d+)?\s+-first\s+(\d+)/) ??
      numberAfter(normalized, /(?:^|\s)-totalcount\s+(\d+)/)
    if (first !== null) return `file:${contentPath}:lines:${skip + 1}-${skip + first}`

    const charStart =
      numberAfter(normalized, /\$(?:start|s)\s*=\s*(\d+)/) ??
      numberAfter(normalized, /\.substring\(\s*(\d+)/)
    if (charStart !== null) return `file:${contentPath}:chars:${charStart}`
    return `file:${contentPath}:full`
  }

  const directoryPath = normalized.match(
    /\bget-childitem(?:\s+(?:-path|-literalpath))?\s+["']?([^\s"'|;,)]+)/
  )?.[1]
  if (directoryPath) return `directory:${directoryPath}`
  return normalized
}

export function unwrapPowerShellCommand(command: string): string {
  const wrapped = command.match(
    /^(?:powershell|pwsh)(?:\.exe)?(?:\s+-(?:NoProfile|NonInteractive|NoLogo))*\s+-(?:Command|c)\s+([\s\S]+)$/i
  )
  if (!wrapped) return command.trim()
  return wrapped[1].trim().replace(/^["']/, '').replace(/["']$/, '')
}

function numberAfter(text: string, pattern: RegExp): number | null {
  const match = text.match(pattern)
  if (!match) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? value : null
}

/**
 * The task-effect kind a call should be counted as, which is not always the
 * kind its tool declares.
 *
 * `run_command` declares `command`, but a model reaching for the shell to read
 * a file is gathering, not acting. That distinction is load-bearing: with
 * `run_command` counted as productive, a turn blocked by the ledger's
 * gathering ladder can reset its allowance by fetching the same lines through
 * the shell instead — which is exactly what a live run did, in its own words,
 * *"The system is blocking repeated info calls. Let me use a command to read the
 * file content I need."* Twenty-two shell reads followed.
 *
 * `title` is Anodex's own record of what ran (`Run: <command>`), written at
 * settlement, so this reads a string the runtime composed rather than anything
 * the model wrote as prose.
 */
export function effectiveToolKind<K extends string>(
  call: { name: string; kind: K; title: string },
  readKind: K
): K {
  return isObservationalRunCommand(call) ? readKind : call.kind
}

/** Whether this call is `run_command` being used to look at something. */
export function isObservationalRunCommand(call: { name: string; title: string }): boolean {
  if (call.name !== 'run_command' || !call.title.startsWith('Run: ')) return false
  return isObservationalCommand(call.title.slice('Run: '.length).trim())
}
