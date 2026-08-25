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
 * The lookbehind rejects a match that starts mid-token: without it, a URL
 * (`github.com/x/y.ts` → `com/x/y.ts`) or an absolute path
 * (`/usr/lib/foo.so` → `usr/lib/foo.so`) yields a workspace-relative-looking
 * fragment that stats to nothing and gets flagged "likely fabricated" on a
 * perfectly honest reply. Sits after the optional backtick so a wrapping
 * backtick itself never blocks the match.
 *
 * `:` joined that rejection class the hard way. A reply that correctly told the
 * user to open `http://localhost:8000/index.html` had `8000/index.html` pulled
 * out of it — the character before `8000` is a colon, which the class did not
 * cover — and was told it had fabricated a path. A false accusation on a
 * correct answer is worse than no check at all, since this machinery is only
 * worth having if the user can trust it, so URLs are additionally masked out
 * wholesale before matching.
 */
const PATH_PATTERN = /`?(?<![\w.:\\/-])((?:\.{1,2}\/)?(?:[\w-]+\/)+[\w.-]+\.[A-Za-z0-9]+)`?/g

/** Any `scheme://…` run, removed before matching so no fragment of one is scanned. */
const URL_PATTERN = /\b[a-z][\w+.-]*:\/\/\S+/gi

function extractCandidatePaths(content: string): string[] {
  const seen = new Set<string>()
  for (const match of content.replace(URL_PATTERN, ' ').matchAll(PATH_PATTERN)) {
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
  const knownRoots = new Map<string, boolean>()
  for (const candidate of extractCandidatePaths(content)) {
    let absolute: string
    try {
      absolute = resolveInWorkspace(workspaceRoot, candidate)
    } catch {
      // Outside the workspace or otherwise malformed — not a claim this
      // check can meaningfully verify either way.
      continue
    }
    // Read OR successfully mutated this task — a verified interaction either
    // way. Checked before `stat`, deliberately: a path this task deleted or
    // renamed no longer exists on disk, and flagging the reply's honest
    // "I deleted `x/y.ts`" as fabricated would be exactly the kind of false
    // accusation this check must never make.
    if (readCoverage.hasInteracted(absolute)) continue
    let info
    try {
      info = await stat(absolute)
    } catch {
      // Missing, but is it even a claim about this project? See
      // `rootDirectoryExists`.
      if (await rootDirectoryExists(workspaceRoot, candidate, knownRoots)) {
        issues.push({ path: candidate, reason: 'not-found' })
      }
      continue
    }
    if (!info.isFile()) continue
    issues.push({ path: candidate, reason: 'not-inspected' })
  }
  return issues
}

/**
 * Whether a missing path's own top directory is part of this workspace.
 *
 * A path can only be a *claim about this project* if its root belongs to the
 * project. `src/main/ipc/tool.handlers.ts` is one: `src/` is real, the file is
 * not, and that is the fabrication this check exists to catch. `GL/gl.h` is
 * not: there is no `GL/` here because it is a Windows SDK header, and the
 * reply naming it in an `#include` is simply correct.
 *
 * Without this, the check told a model that its own working `#include
 * <GL/gl.h>` was "likely fabricated or misspelled" -- observed live during a
 * C++ build. That is worse than saying nothing: it is a confident false
 * accusation about correct code, and the obvious way for a model to act on it
 * is to break something that worked. Every language has this shape --
 * `<sys/stat.h>`, `<boost/asio.hpp>`, `os/path` -- so it is not a C++ quirk.
 *
 * The trade, stated plainly: a fabricated path under a directory that does not
 * exist either (`lib/utils.ts` in a project with no `lib/`) now goes unflagged.
 * That is the right way round. Missing an exotic fabrication costs a little
 * assurance; accusing correct code costs trust and invites a real regression.
 */
async function rootDirectoryExists(
  workspaceRoot: string,
  candidate: string,
  cache: Map<string, boolean>
): Promise<boolean> {
  const segments = candidate
    .split('/')
    .filter((part) => part !== '' && part !== '.' && part !== '..')
  // No directory component at all (a bare `foo.ts`) is not evidence either way.
  if (segments.length < 2) return false
  const root = segments[0]
  const cached = cache.get(root)
  if (cached !== undefined) return cached
  let exists = false
  try {
    exists = (await stat(resolveInWorkspace(workspaceRoot, root))).isDirectory()
  } catch {
    exists = false
  }
  cache.set(root, exists)
  return exists
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
