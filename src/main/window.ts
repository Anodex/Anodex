import { BrowserWindow, shell } from 'electron'
import { join } from 'node:path'

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
 * Security posture: `contextIsolation` on and `nodeIntegration` off — the
 * renderer can only reach the main process through the typed preload bridge.
 */
export function createMainWindow(): BrowserWindow {
  const devServerUrl = process.env['ELECTRON_RENDERER_URL']

  const window = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 940,
    minHeight: 620,
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
      sandbox: false
    }
  })

  // Avoid a flash of unstyled/empty content: show only once rendered.
  window.once('ready-to-show', () => window.show())

  // Open external links in the user's default browser, never inside the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (devServerUrl) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow = window
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  return window
}
