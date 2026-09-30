import { beforeEach, describe, expect, it, vi } from 'vitest'

function stubStorage(initial: Record<string, string> = {}): Map<string, string> {
  const store = new Map(Object.entries(initial))
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value)
  })
  return store
}

async function loadDock(): Promise<typeof import('../useWorkspaceDock')> {
  vi.resetModules()
  return import('../useWorkspaceDock')
}

describe('useWorkspaceDock', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('opens on a panel, and a second press of its shortcut closes it', async () => {
    stubStorage()
    const { useWorkspaceDock } = await loadDock()
    const dock = useWorkspaceDock.getState()

    dock.togglePanel('terminal')
    expect(useWorkspaceDock.getState()).toMatchObject({ open: true, activePanel: 'terminal' })

    useWorkspaceDock.getState().togglePanel('terminal')
    expect(useWorkspaceDock.getState().open).toBe(false)
  })

  it('switches panels without closing when another shortcut is pressed', async () => {
    stubStorage()
    const { useWorkspaceDock } = await loadDock()
    useWorkspaceDock.getState().togglePanel('plan')
    useWorkspaceDock.getState().togglePanel('files')
    expect(useWorkspaceDock.getState()).toMatchObject({ open: true, activePanel: 'files' })
  })

  it('remembers the open panel across restarts', async () => {
    const storage = stubStorage()
    const first = await loadDock()
    first.useWorkspaceDock.getState().showPanel('git')

    stubStorage(Object.fromEntries(storage))
    const second = await loadDock()
    expect(second.useWorkspaceDock.getState()).toMatchObject({ open: true, activePanel: 'git' })
  })

  it('opens on the first panel someone had switched on in the stacked dock', async () => {
    stubStorage({ 'anodex:dockEnabledPanels': JSON.stringify({ plan: false, files: true }) })
    const { useWorkspaceDock } = await loadDock()
    expect(useWorkspaceDock.getState().activePanel).toBe('files')
  })
})
