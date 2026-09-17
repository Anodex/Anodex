import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * Which folder a workspace call reads from.
 *
 * Anodex had two answers. `checkpoints:*` resolves against the *conversation's*
 * project, looked up by the id in the request. Every `workspace:*` handler
 * resolved against `settings.workspace.root`, which follows the *active*
 * project — `ProjectStore` rewrites it on every switch, and nothing else does.
 *
 * They agree until somebody opens a conversation belonging to a project that is
 * not the active one. A phone does that by scrolling its list. Found on
 * 2026-09-17 by using the new diff view against a live desktop: the diff for a
 * turn drew correctly out of one project, and the "open the file as it is now"
 * button beside it failed, because the file reader was looking in another.
 *
 * The fix is not a fallback. It is letting a caller say which project it means,
 * and answering about that one.
 */

const projects = [
  { id: 'p-sandbox', name: 'Sandbox', folderPath: 'C:\\work\\Sandbox' },
  { id: 'p-bench', name: 'Bench', folderPath: 'C:\\work\\Sandbox\\Bench' }
]

let activeProjectId: string | null = 'p-bench'
let workspaceRoot: string | null = 'C:\\work\\Sandbox\\Bench'

vi.mock('../../projects/ProjectStore', () => ({
  projectStore: { getState: () => ({ projects, activeProjectId }) }
}))

vi.mock('../../settings/SettingsStore', () => ({
  settingsStore: { get: () => ({ workspace: { root: workspaceRoot } }) }
}))

const { rootFor } = await import('../workspaceRoot')

beforeEach(() => {
  activeProjectId = 'p-bench'
  workspaceRoot = 'C:\\work\\Sandbox\\Bench'
})

describe('the folder a workspace call reads from', () => {
  it('answers about the project the caller named', () => {
    // The bug, stated as a test. The active project is Bench; the caller is
    // looking at a conversation that ran in Sandbox. Before this, it was
    // answered about Bench and the file was not there.
    expect(rootFor('p-sandbox')).toBe('C:\\work\\Sandbox')
  })

  it('falls back to the active project when no one names one', () => {
    // Every existing call from the window, unchanged. The window shows the
    // active project, so the active project is what it means.
    expect(rootFor()).toBe('C:\\work\\Sandbox\\Bench')
    expect(rootFor(null)).toBe('C:\\work\\Sandbox\\Bench')
  })

  it('refuses rather than guessing when the named project is gone', () => {
    // A project deleted, or an id from an older client. Answering about some
    // other folder would read the wrong file and report success — which is the
    // failure this whole change is about, only quieter.
    expect(rootFor('p-deleted')).toBeNull()
  })

  it('has nothing to say when nothing is selected and nobody asked', () => {
    workspaceRoot = null
    expect(rootFor()).toBeNull()
  })

  it('still answers a named project when no project is active at all', () => {
    // The state the live failure was actually in: no workspace root set, so the
    // old code could only say "no workspace folder is selected" even though the
    // caller knew exactly which project it meant.
    workspaceRoot = null
    activeProjectId = null
    expect(rootFor('p-sandbox')).toBe('C:\\work\\Sandbox')
  })
})
