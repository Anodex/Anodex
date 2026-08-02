import { BrowserWindow, screen, shell } from 'electron'
import { getMainWindow } from './window'
import { createLogger } from './utils/logger'

const log = createLogger('html-preview-window')

const DEFAULT_WIDTH = 1024
const DEFAULT_HEIGHT = 768
const MIN_WIDTH = 320
const MIN_HEIGHT = 240

/**
 * Pop-out preview windows, keyed by the workspace-relative path of the HTML
 * file they're showing. Re-opening the same file refreshes and focuses the
 * window that's already up instead of stacking duplicates, and the file
 * viewer pushes fresh content into it as the file changes.
 */
const windows = new Map<string, BrowserWindow>()

/**
 * Open (or refresh) a standalone window showing an HTML page from the
 * workspace.
 *
 * Security posture: this content is AI-written or otherwise untrusted, so the
 * window gets none of Anodex's own capabilities — no preload bridge, no node
 * integration, `sandbox` on. Content is handed over as a `data:` URL rather
 * than a `file://` one, which gives the page an opaque origin: scripts run (so
 * a real page behaves like a real page, matching the in-chat preview's
 * `sandbox="allow-scripts"`), but it cannot read the user's disk, reach any
 * app state, or make same-origin requests anywhere. `content` is expected to
 * already be self-contained — see `prepareHtmlPreviewSource`, which inlines
 * local stylesheets, scripts, and images, since an opaque origin can't fetch
 * siblings for itself.
 */
export function openHtmlPreviewWindow(key: string, title: string, content: string): void {
  const existing = windows.get(key)
  if (existing && !existing.isDestroyed()) {
    existing.setTitle(title)
    loadContent(existing, content)
    if (existing.isMinimized()) existing.restore()
    existing.focus()
    return
  }

  const window = new BrowserWindow({
    ...initialBounds(),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    title,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Deliberately no preload: the previewed page must not be able to reach
      // Anodex's IPC bridge.
      webSecurity: true
    }
  })
  windows.set(key, window)

  // The page keeps whatever <title> it declares out of the window chrome —
  // the file path is more useful to the user than an AI-authored title, and
  // it keeps the previewed document from choosing its own window caption.
  window.on('page-title-updated', (event) => event.preventDefault())

  // Links and popups leave for the real browser rather than turning this
  // window into an uncontrolled, un-navigable browser of its own.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) {
      shell.openExternal(url).catch((error) => log.error('Failed to open external URL:', error))
    }
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    if (/^https?:/i.test(url)) {
      shell.openExternal(url).catch((error) => log.error('Failed to open external URL:', error))
    }
  })

  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    if (windows.get(key) === window) windows.delete(key)
  })

  loadContent(window, content)
}

/** Refresh an already-open pop-out; a no-op if this file has no window up. */
export function refreshHtmlPreviewWindow(key: string, content: string): void {
  const window = windows.get(key)
  if (!window || window.isDestroyed()) return
  loadContent(window, content)
}

/** Whether a pop-out window is currently open for this file. */
export function hasHtmlPreviewWindow(key: string): boolean {
  const window = windows.get(key)
  return Boolean(window && !window.isDestroyed())
}

/** Close every pop-out — called on app quit. */
export function closeHtmlPreviewWindows(): void {
  for (const window of windows.values()) {
    if (!window.isDestroyed()) window.close()
  }
  windows.clear()
}

function loadContent(window: BrowserWindow, content: string): void {
  const dataUrl = `data:text/html;charset=utf-8;base64,${Buffer.from(content, 'utf-8').toString('base64')}`
  window.loadURL(dataUrl).catch((error) => log.error('Failed to load preview content:', error))
}

/**
 * Open on whichever display the main window is on, nudged slightly off its
 * top-left corner so a maximized Anodex doesn't hide the new window exactly
 * behind itself, and always clamped inside the display's work area.
 */
function initialBounds(): { x?: number; y?: number; width: number; height: number } {
  const mainWindow = getMainWindow()
  if (!mainWindow) return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }

  const area = screen.getDisplayMatching(mainWindow.getBounds()).workArea
  const width = Math.min(DEFAULT_WIDTH, area.width)
  const height = Math.min(DEFAULT_HEIGHT, area.height)
  const main = mainWindow.getBounds()
  return {
    x: Math.max(area.x, Math.min(main.x + 48, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(main.y + 48, area.y + area.height - height)),
    width,
    height
  }
}
