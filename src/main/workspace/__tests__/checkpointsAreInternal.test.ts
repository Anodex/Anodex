import { describe, expect, it } from 'vitest'

/**
 * Anodex's own checkpoint blobs stay out of the file listing.
 *
 * They are UUID-named snapshots of every file a turn touched, and there can be
 * hundreds. The Files panel is for somebody's project, not for Anodex's
 * bookkeeping — the listing has excluded them since it was written.
 *
 * It excluded them by comparing the whole relative path to
 * `.anodex/checkpoints`, which is only ever the *root's* copy. Projects nest:
 * `Sandbox` contains `Sandbox/Bench`, and both are projects. Browsing the
 * parent walked into the child's checkpoints and filled the panel with
 * `agent_msg_*.json`, burying the files somebody opened it to find.
 *
 * Found by opening the Files panel on a real phone and looking at what was in
 * it, which is not something a test would have thought to do.
 */

/** The rule as `listWorkspaceFiles` applies it. */
const CHECKPOINTS_DIR = '.anodex/checkpoints'
function isCheckpointsDir(path: string): boolean {
  return path === CHECKPOINTS_DIR || path.endsWith(`/${CHECKPOINTS_DIR}`)
}

describe('what the file listing hides', () => {
  it('hides the project root’s own checkpoints', () => {
    expect(isCheckpointsDir('.anodex/checkpoints')).toBe(true)
  })

  it('hides a nested project’s checkpoints, which is the bug', () => {
    expect(isCheckpointsDir('Bench/.anodex/checkpoints')).toBe(true)
    expect(isCheckpointsDir('packages/app/.anodex/checkpoints')).toBe(true)
  })

  it('leaves the rest of .anodex alone', () => {
    // Skills and notes live there too and are the user's, not bookkeeping.
    expect(isCheckpointsDir('.anodex')).toBe(false)
    expect(isCheckpointsDir('.anodex/skills')).toBe(false)
    expect(isCheckpointsDir('Bench/.anodex/notes')).toBe(false)
  })

  it('does not hide a folder that merely ends in the same words', () => {
    // `my.anodex/checkpoints` is somebody's own directory, not ours.
    expect(isCheckpointsDir('checkpoints')).toBe(false)
    expect(isCheckpointsDir('docs/checkpoints')).toBe(false)
  })
})
