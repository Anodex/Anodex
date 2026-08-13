import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { AnodexFileViewerControlTarget } from '../AnodexFileViewerControlTarget'

const getMainWindow = vi.hoisted(() => vi.fn())

vi.mock('../../window', () => ({ getMainWindow }))

function windowTarget(
  pointTarget: string | null,
  activeTarget = pointTarget
): {
  window: BrowserWindow
  executeJavaScript: ReturnType<typeof vi.fn>
  sendInputEvent: ReturnType<typeof vi.fn>
  insertText: ReturnType<typeof vi.fn>
} {
  const executeJavaScript = vi.fn((source: string) =>
    Promise.resolve(source.includes('document.activeElement') ? activeTarget : pointTarget)
  )
  const sendInputEvent = vi.fn()
  const insertText = vi.fn(() => Promise.resolve())
  const window = {
    isDestroyed: () => false,
    getContentBounds: () => ({ width: 1200, height: 800 }),
    webContents: { executeJavaScript, sendInputEvent, insertText },
    once: vi.fn(),
    removeListener: vi.fn()
  } as unknown as BrowserWindow
  getMainWindow.mockReturnValue(window)
  return { window, executeJavaScript, sendInputEvent, insertText }
}

describe('AnodexFileViewerControlTarget', () => {
  it('dispatches input only to an explicitly tagged File Viewer control', async () => {
    const fake = windowTarget('file-viewer-mode')
    const target = new AnodexFileViewerControlTarget(fake.window)

    await target.execute({ type: 'click', x: 300, y: 40 }, new AbortController().signal)

    expect(fake.executeJavaScript).toHaveBeenCalledTimes(1)
    expect(fake.sendInputEvent).toHaveBeenCalledWith({ type: 'mouseDown', x: 300, y: 40 })
    expect(fake.sendInputEvent).toHaveBeenCalledWith({ type: 'mouseUp', x: 300, y: 40 })
  })

  it('refuses untagged controls before dispatching any input', async () => {
    const fake = windowTarget('settings-save')
    const target = new AnodexFileViewerControlTarget(fake.window)

    await expect(
      target.execute({ type: 'click', x: 300, y: 40 }, new AbortController().signal)
    ).rejects.toThrow('outside the enabled File Viewer surface')

    expect(fake.sendInputEvent).not.toHaveBeenCalled()
  })

  it('requires the explicitly tagged editor to have focus before text or keys can be sent', async () => {
    const fake = windowTarget('file-viewer-mode')
    const target = new AnodexFileViewerControlTarget(fake.window)

    await expect(
      target.execute({ type: 'type', text: 'unsafe' }, new AbortController().signal)
    ).rejects.toThrow('Focus the enabled Anodex File Viewer editor')
    await expect(
      target.assessAction({ type: 'keypress', keys: ['Enter'] }, new AbortController().signal)
    ).rejects.toThrow('Focus the enabled Anodex File Viewer editor')
  })

  it('types and sends only safe single keys in the explicitly tagged editor', async () => {
    const fake = windowTarget('file-viewer-editor')
    const target = new AnodexFileViewerControlTarget(fake.window)

    await target.execute({ type: 'type', text: 'safe editor text' }, new AbortController().signal)
    await target.execute({ type: 'keypress', keys: ['Backspace'] }, new AbortController().signal)

    expect(fake.insertText).toHaveBeenCalledWith('safe editor text')
    expect(fake.sendInputEvent).toHaveBeenCalledWith({ type: 'keyDown', keyCode: 'Backspace' })
    expect(fake.sendInputEvent).toHaveBeenCalledWith({ type: 'keyUp', keyCode: 'Backspace' })
    await expect(
      target.assessAction({ type: 'keypress', keys: ['Ctrl', 'S'] }, new AbortController().signal)
    ).rejects.toThrow('only one safe editor navigation or editing key')
  })

  it('requires approval for text edits and Save', async () => {
    const editor = windowTarget('file-viewer-editor')
    const target = new AnodexFileViewerControlTarget(editor.window)
    await expect(
      target.assessAction({ type: 'type', text: 'change' }, new AbortController().signal)
    ).resolves.toContain('Type 6 characters')

    const save = windowTarget('file-viewer-save')
    const saveTarget = new AnodexFileViewerControlTarget(save.window)
    await expect(
      saveTarget.assessAction({ type: 'click', x: 300, y: 40 }, new AbortController().signal)
    ).resolves.toContain('Save the current file')
  })
})
