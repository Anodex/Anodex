import { describe, expect, it, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

interface IpcTestHandler {
  (event: unknown, ...args: unknown[]): unknown
}

const mocks = vi.hoisted(() => ({ handlers: new Map<string, IpcTestHandler>() }))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcTestHandler) => {
      mocks.handlers.set(channel, handler)
    })
  },
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: vi.fn() }
}))

import { IpcChannel } from '@shared/ipc'
import { installContextMenu, registerContextMenuHandlers } from '../contextMenu'

function fakeWindow(): {
  webContents: EventEmitter & {
    send: ReturnType<typeof vi.fn>
    selectAll: ReturnType<typeof vi.fn>
    copy: ReturnType<typeof vi.fn>
  }
} {
  const webContents = Object.assign(new EventEmitter(), {
    send: vi.fn(),
    selectAll: vi.fn(),
    copy: vi.fn()
  })
  return { webContents }
}

function baseParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    x: 1,
    y: 1,
    linkURL: '',
    isEditable: false,
    selectionText: 'hello',
    misspelledWord: '',
    dictionarySuggestions: [],
    editFlags: {
      canUndo: false,
      canRedo: false,
      canCut: false,
      canCopy: true,
      canPaste: false,
      canSelectAll: false
    },
    ...overrides
  }
}

describe('context menu action lifecycle', () => {
  beforeEach(() => {
    mocks.handlers.clear()
  })

  it('runs an action from a menu that is still alive when a newer menu has since opened', () => {
    const window = fakeWindow()
    installContextMenu(window as never)
    registerContextMenuHandlers()
    const runAction = mocks.handlers.get(IpcChannel.ContextMenu.runAction)
    expect(runAction).toBeDefined()

    // Open menu A and capture the id of its one action (Copy).
    window.webContents.emit('context-menu', {}, baseParams())
    const firstRequest = window.webContents.send.mock.calls[0][1] as { items: { id: string }[] }
    const firstActionId = firstRequest.items[0].id

    // A second menu opens before the first click's invoke is handled —
    // this used to wipe the shared action map and silently drop the click.
    window.webContents.emit('context-menu', {}, baseParams())

    expect(() => runAction?.({}, firstActionId)).not.toThrow()
    expect(window.webContents.copy).toHaveBeenCalledTimes(1)
  })

  it('drops actions from menus older than the retained generation window', () => {
    const window = fakeWindow()
    installContextMenu(window as never)
    registerContextMenuHandlers()
    const runAction = mocks.handlers.get(IpcChannel.ContextMenu.runAction)

    window.webContents.emit('context-menu', {}, baseParams())
    const staleRequest = window.webContents.send.mock.calls[0][1] as { items: { id: string }[] }
    const staleActionId = staleRequest.items[0].id

    // Open far more newer menus than the retention window could ever cover,
    // so this doesn't hinge on the exact retained-generation count.
    for (let i = 0; i < 20; i++) {
      window.webContents.emit('context-menu', {}, baseParams())
    }

    expect(() => runAction?.({}, staleActionId)).not.toThrow()
    expect(window.webContents.copy).not.toHaveBeenCalled()
  })

  it('does not fire the same action twice for one click', () => {
    const window = fakeWindow()
    installContextMenu(window as never)
    registerContextMenuHandlers()
    const runAction = mocks.handlers.get(IpcChannel.ContextMenu.runAction)

    window.webContents.emit('context-menu', {}, baseParams())
    const request = window.webContents.send.mock.calls[0][1] as { items: { id: string }[] }
    const actionId = request.items[0].id

    runAction?.({}, actionId)
    runAction?.({}, actionId)

    expect(window.webContents.copy).toHaveBeenCalledTimes(1)
  })
})
