/**
 * Directory names every workspace walk skips — shared by the search/find/
 * outline tools and by the workspace orientation summary, so "is this worth
 * walking into" stays a single definition instead of two lists that can
 * silently drift apart. Same reasoning as `TEXT_EXT` in
 * `textFileExtensions.ts`.
 *
 * `.anodex` is the important one and the reason this file exists. It is
 * Anodex's *own* per-project metadata — the checkpoint snapshots it writes for
 * every message — and it was not skipped by either list. Because the walk stops
 * at `SEARCH_HARD_CAP` matches and `.anodex` sorts before most project folders,
 * a search filled its entire budget with Anodex's own stored copies of the
 * user's files and never reached the real ones. Measured on a live run: every
 * one of the first 200 matches for `_label`, `_card` and `properties` came from
 * `.anodex/checkpoints`, and the model concluded "search tools are
 * misbehaving" and fell back to reading whole files by hand.
 *
 * It also gets worse the longer a project is used, because a checkpoint is
 * written per message — so the tool degrades exactly as a user invests in it.
 */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  '.anodex',
  'node_modules',
  '.git',
  'dist',
  'out',
  '.next',
  '.cache',
  'build',
  '.turbo'
])
