import { BrowserWindow, clipboard, ipcMain, shell, type ContextMenuParams } from 'electron'
import { IpcChannel, type ContextMenuItem, type ContextMenuRequest } from '@shared/ipc'
import { sendToWindow } from './broadcast'
import { createLogger } from './utils/logger'

const log = createLogger('context-menu')
/**
 * One action map per opened menu, keyed by an incrementing generation
 * rather than a single shared `Map` that gets wiped on every new menu.
 * A shared map cleared on each `context-menu` event raced a fast follow-up
 * right-click against an in-flight `runAction` invoke for the PREVIOUS
 * menu: clicking an item calls `runAction` (async) and immediately closes
 * the renderer's menu, but if another `context-menu` event lands before
 * that invoke resolves, the old code's `actions.clear()` would wipe the
 * clicked item's entry out from under it, silently dropping the click.
 * Keeping the last few generations alive gives any in-flight invoke room
 * to resolve; old generations are pruned on the next menu build so this
 * doesn't grow unbounded from menus that are opened and then dismissed.
 */
const MAX_LIVE_GENERATIONS = 3
let nextGeneration = 0
const actionsByGeneration = new Map<number, Map<string, () => void>>()
// `Date.now()` alone can repeat across menus built within the same
// millisecond (readily hit by rapid right-clicks); a monotonic counter
// guarantees every item id is unique regardless of timing.
let nextItemId = 0

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
  const id = `context-menu-${nextItemId++}`
  items.push({ id, label, enabled })
  if (enabled) actionMap.set(id, action)
}

function createSeparator(items: ContextMenuItem[]): void {
  items.push({
    id: `context-menu-separator-${nextItemId++}`,
    label: '',
    enabled: false,
    type: 'separator'
  })
}

function buildContextMenu(
  window: BrowserWindow,
  params: ContextMenuParams
): ContextMenuBuildResult {
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
        id: `context-menu-no-suggestions-${nextItemId++}`,
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
    createAction(
      items,
      actionMap,
      'Undo',
      () => window.webContents.undo(),
      params.editFlags.canUndo
    )
    createAction(
      items,
      actionMap,
      'Redo',
      () => window.webContents.redo(),
      params.editFlags.canRedo
    )
    createSeparator(items)
    createAction(items, actionMap, 'Cut', () => window.webContents.cut(), params.editFlags.canCut)
    createAction(
      items,
      actionMap,
      'Copy',
      () => window.webContents.copy(),
      params.editFlags.canCopy
    )
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

    actionsByGeneration.set(nextGeneration++, built.actions)
    for (const generation of actionsByGeneration.keys()) {
      if (generation <= nextGeneration - 1 - MAX_LIVE_GENERATIONS) {
        actionsByGeneration.delete(generation)
      }
    }

    const request: ContextMenuRequest = {
      x: params.x,
      y: params.y,
      items: built.items
    }
    sendToWindow(window, IpcChannel.ContextMenu.show, request)
  })
}

export function registerContextMenuHandlers(): void {
  ipcMain.handle(IpcChannel.ContextMenu.runAction, (_event, id: string) => {
    for (const actions of actionsByGeneration.values()) {
      const action = actions.get(id)
      if (action) {
        actions.delete(id)
        action()
        return
      }
    }
  })
}
