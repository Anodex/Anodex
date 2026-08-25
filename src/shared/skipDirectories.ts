/**
 * Directory names every workspace walk skips — shared by the search/find/
 * outline tools and by the workspace orientation summary, so "is this worth
 * walking into" stays a single definition instead of two lists that can
 * silently drift apart. Same reasoning as `TEXT_EXT` in
 * `textFileExtensions.ts`.
 */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  '.next',
  '.cache',
  'build',
  '.turbo'
])

/**
 * Workspace-relative directories that hold Anodex's own bookkeeping rather than
 * the user's work.
 *
 * `.anodex/checkpoints` is the one that matters and the reason this exists: it
 * stores a full copy of every file Anodex edits, once per message. Unskipped,
 * a search spent its entire `SEARCH_HARD_CAP` budget inside those copies and
 * never reached the real source, because `.anodex` sorts before most project
 * folders. Measured live: all 200 first matches for `_label`, `_card` and
 * `properties` came from checkpoints, and the model concluded "search tools are
 * misbehaving" and read whole files by hand instead. It also degrades with use,
 * since a checkpoint is written per message.
 *
 * Matched by path, not by name, because the rest of `.anodex` is genuinely the
 * user's: `SPEC.md`, `changes/` proposals and project `skills/` are all things
 * someone would reasonably search for. `listWorkspaceFiles` already draws the
 * line in exactly this place.
 */
const INTERNAL_DIRS: readonly string[] = ['.anodex/checkpoints']

/** Whether a walk should descend into this directory. */
export function isSkippedDirectory(name: string, workspaceRelativePath: string): boolean {
  if (SKIP_DIRS.has(name)) return true
  return INTERNAL_DIRS.includes(normalizeSeparators(workspaceRelativePath))
}

/** Windows walks produce backslash paths; the list above is written with slashes. */
function normalizeSeparators(value: string): string {
  return value.split(String.fromCharCode(92)).join('/')
}
