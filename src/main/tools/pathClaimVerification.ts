import { stat } from 'node:fs/promises'
import { resolveInWorkspace } from './workspace'
import type { ReadCoverageTracker } from './readCoverage'

/**
 * A file path mentioned in a reply that couldn't be verified against what
 * really happened this task. See `findUnverifiedPathClaims`'s doc comment
 * for the failure this catches.
 */
export interface PathClaimIssue {
  path: string
  /**
   * `'not-found'` — the path doesn't exist in the workspace at all (almost
   * certainly fabricated or misspelled). `'not-inspected'` — the path is
   * real, but no tool call actually read any part of it this task; the
   * model may be recalling it from the workspace file-tree context, prior
   * training knowledge, or simply inventing plausible-sounding detail.
   */
  reason: 'not-found' | 'not-inspected'
}

/**
 * A relative-looking code file path, optionally backtick-wrapped. The final
 * segment allows internal dots (`[\w.-]+`), not just `\w`, so a multi-dot
 * filename like `tool.handlers.ts` or `foo.test.ts` is captured whole —
 * greedy backtracking still finds the last dot as the extension separator.
 */
const PATH_PATTERN = /`?((?:\.{1,2}\/)?(?:[\w-]+\/)+[\w.-]+\.[A-Za-z0-9]+)`?/g

function extractCandidatePaths(content: string): string[] {
  const seen = new Set<string>()
  for (const match of content.matchAll(PATH_PATTERN)) {
    if (match[1]) seen.add(match[1])
  }
  return [...seen]
}

/**
 * Cross-checks every file-path-shaped token in a reply's own text against
 * what actually happened this task: does the path exist, and did a real
 * tool call actually read any part of it (via `readCoverage`)? A live retest
 * of the bounded chat continuation produced a final report whose "IPC
 * Layer" table cited `src/main/ipc/tool.handlers.ts`, `config.handlers.ts`,
 * and `file.handlers.ts` — none of which exist (the real file is
 * `tools.handlers.ts`) — and also claimed to have analyzed
 * `chat.handlers.ts`, which was never actually opened that run. That
 * fabrication happened in a synthesis cycle that made zero new tool calls:
 * the model, still under instruction to name "at least 12 files," invented
 * plausible-sounding coverage instead of reporting what it actually saw.
 *
 * This is a deterministic, after-the-fact check — it doesn't stop the
 * fabrication from being generated, but it means it's never silently
 * trusted: see `describeUnverifiedPathClaims` for how these are surfaced.
 * `readCoverage` is keyed by absolute, workspace-resolved path (see
 * `ReadCoverageTracker`'s doc comment), so candidates are resolved the same
 * way before checking.
 */
export async function findUnverifiedPathClaims(
  content: string,
  workspaceRoot: string | null,
  readCoverage: ReadCoverageTracker
): Promise<PathClaimIssue[]> {
  if (!workspaceRoot) return []
  const issues: PathClaimIssue[] = []
  for (const candidate of extractCandidatePaths(content)) {
    let absolute: string
    try {
      absolute = resolveInWorkspace(workspaceRoot, candidate)
    } catch {
      // Outside the workspace or otherwise malformed — not a claim this
      // check can meaningfully verify either way.
      continue
    }
    let info
    try {
      info = await stat(absolute)
    } catch {
      issues.push({ path: candidate, reason: 'not-found' })
      continue
    }
    if (!info.isFile()) continue
    if (!readCoverage.hasAnyCoverage(absolute)) {
      issues.push({ path: candidate, reason: 'not-inspected' })
    }
  }
  return issues
}

/** A calm, factual note appended to a reply's own text — `null` when there's nothing to flag. */
export function describeUnverifiedPathClaims(issues: PathClaimIssue[]): string | null {
  if (issues.length === 0) return null
  const notFound = issues.filter((issue) => issue.reason === 'not-found')
  const notInspected = issues.filter((issue) => issue.reason === 'not-inspected')
  const lines: string[] = []
  if (notFound.length > 0) {
    lines.push(
      `Don't exist in this workspace (likely fabricated or misspelled): ${notFound
        .map((issue) => `\`${issue.path}\``)
        .join(', ')}`
    )
  }
  if (notInspected.length > 0) {
    lines.push(
      `Exist, but no tool call actually read them this task: ${notInspected
        .map((issue) => `\`${issue.path}\``)
        .join(', ')}`
    )
  }
  return (
    '\n\n---\n**Note: some file paths above were not verified against real tool calls this task.**\n' +
    lines.map((line) => `- ${line}`).join('\n')
  )
}
