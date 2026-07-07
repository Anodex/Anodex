import { BrowserWindow, clipboard, ipcMain, shell, type ContextMenuParams } from 'electron'
import { IpcChannel, type ContextMenuItem, type ContextMenuRequest } from '@shared/ipc'
import { createLogger } from './utils/logger'

const log = createLogger('context-menu')
const actions = new Map<string, () => void>()

interface ContextMenuBuildResult {
  items: ContextMenuItem[]
  actions: Map<string, () => void>
}

function createAction(
  items: ContextMenuItem[],
  actionMap: Map<string, () => void>,
  label: string,
  action: () => void,
  enabled = true
): void {
  const id = `context-menu-${items.length}-${Date.now()}`
  items.push({ id, label, enabled })
  if (enabled) actionMap.set(id, action)
}

function createSeparator(items: ContextMenuItem[]): void {
  items.push({
    id: `context-menu-separator-${items.length}-${Date.now()}`,
    label: '',
    enabled: false,
    type: 'separator'
  })
}

function buildContextMenu(window: BrowserWindow, params: ContextMenuParams): ContextMenuBuildResult {
  const items: ContextMenuItem[] = []
  const actionMap = new Map<string, () => void>()

  if (params.linkURL) {
    createAction(items, actionMap, 'Open Link in Browser', () => {
      shell
        .openExternal(params.linkURL)
        .catch((error) => log.error('Failed to open external URL:', params.linkURL, error))
    })
    createAction(items, actionMap, 'Copy Link', () => clipboard.writeText(params.linkURL))
    createSeparator(items)
  }

  if (params.isEditable && params.misspelledWord) {
    for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
      createAction(items, actionMap, suggestion, () =>
        window.webContents.replaceMisspelling(suggestion)
      )
    }

    if (params.dictionarySuggestions.length === 0) {
      items.push({
        id: `context-menu-no-suggestions-${Date.now()}`,
        label: 'No Spelling Suggestions',
        enabled: false
      })
    }

    createAction(items, actionMap, 'Add to Dictionary', () =>
      window.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord)
    )
    createSeparator(items)
  }

  if (params.isEditable) {
    createAction(items, actionMap, 'Undo', () => window.webContents.undo(), params.editFlags.canUndo)
    createAction(items, actionMap, 'Redo', () => window.webContents.redo(), params.editFlags.canRedo)
    createSeparator(items)
    createAction(items, actionMap, 'Cut', () => window.webContents.cut(), params.editFlags.canCut)
    createAction(items, actionMap, 'Copy', () => window.webContents.copy(), params.editFlags.canCopy)
    createAction(
      items,
      actionMap,
      'Paste',
      () => window.webContents.paste(),
      params.editFlags.canPaste
    )
    createSeparator(items)
    createAction(
      items,
      actionMap,
      'Select All',
      () => window.webContents.selectAll(),
      params.editFlags.canSelectAll
    )
  } else if (params.selectionText) {
    createAction(items, actionMap, 'Copy', () => window.webContents.copy())
  }

  return { items, actions: actionMap }
}

export function installContextMenu(window: BrowserWindow): void {
  window.webContents.on('context-menu', (_event, params) => {
    const built = buildContextMenu(window, params)
    if (built.items.length === 0) return

    actions.clear()
    for (const [id, action] of built.actions) actions.set(id, action)

    const request: ContextMenuRequest = {
      x: params.x,
      y: params.y,
      items: built.items
    }
    window.webContents.send(IpcChannel.ContextMenu.show, request)
  })
}

export function registerContextMenuHandlers(): void {
  ipcMain.handle(IpcChannel.ContextMenu.runAction, (_event, id: string) => {
    const action = actions.get(id)
    actions.clear()
    if (action) action()
  })
}
