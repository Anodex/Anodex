import { BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { IpcChannel } from '@shared/ipc'
import { installContextMenu } from './contextMenu'
import { createLogger } from './utils/logger'

const log = createLogger('window')

/** Background colour matches the app shell so there is no white flash on launch. */
const BACKGROUND_COLOR = '#0A0E1A'

/**
 * Tracked so a toast window (a separate, always-on-top `BrowserWindow`, see
 * `toastWindow.ts`) can bring the real app window to the foreground when
 * clicked, without needing to guess which of `BrowserWindow.getAllWindows()`
 * is the main one.
 */
let mainWindow: BrowserWindow | null = null

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

/**
 * Create the main application window.
 *
 * Security posture: `contextIsolation` and `sandbox` on, `nodeIntegration`
 * off — the renderer can only reach the main process through the typed
 * preload bridge. The preload script only touches sandbox-compatible APIs
 * (`contextBridge`, `ipcRenderer`, `webUtils`), so this needed no rework.
 */
export function createMainWindow(): BrowserWindow {
  const devServerUrl = process.env['ELECTRON_RENDERER_URL']

  const window = new BrowserWindow({
    width: 1240,
    height: 820,
    // The renderer's own layout collapses gracefully well below this (sidebar
    // rail at <760px width, composer/approval cards cap and scroll instead of
    // pushing out the transcript below ~640px height) — this floor only needs
    // to keep the smallest usable frame: a collapsed sidebar rail plus a
    // legible main content column.
    minWidth: 480,
    minHeight: 480,
    show: false,
    backgroundColor: BACKGROUND_COLOR,
    autoHideMenuBar: true,
    frame: process.platform !== 'darwin' ? false : undefined,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    // Only needed in an unpackaged dev run — without it, Windows/Linux show
    // the generic Electron icon in the taskbar. A packaged build gets its
    // icon from the .exe's own embedded resource instead (`win.icon` in
    // electron-builder.yml); `build/` isn't shipped in the packaged app's
    // files, so this path wouldn't resolve there anyway.
    icon: devServerUrl ? join(__dirname, '../../build/icon.png') : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // Avoid a flash of unstyled/empty content: show only once rendered.
  window.once('ready-to-show', () => window.show())

  // Broadcast maximize/unmaximize changes so the TitleBar can show the
  // correct icon — registered here, where the window reference already
  // exists, rather than waiting on a renderer-sent handshake.
  window.on('maximize', () => {
    if (!window.isDestroyed()) window.webContents.send(IpcChannel.Window.maximizedChanged, true)
  })
  window.on('unmaximize', () => {
    if (!window.isDestroyed()) window.webContents.send(IpcChannel.Window.maximizedChanged, false)
  })

  // Open external links in the user's default browser, never inside the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch((error) => log.error('Failed to open external URL:', url, error))
    return { action: 'deny' }
  })

  installContextMenu(window)

  if (devServerUrl) {
    window.loadURL(devServerUrl).catch((error) => {
      log.error('Failed to load dev server URL:', devServerUrl, error)
    })
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html')).catch((error) => {
      log.error('Failed to load renderer index.html:', error)
    })
  }

  mainWindow = window
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  return window
}
