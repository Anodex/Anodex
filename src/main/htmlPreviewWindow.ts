import { BrowserWindow, screen, shell } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import type { ChatImageInput } from '@shared/chat.types'
import type { ComputerControlScope, ValidatedComputerAction } from '@shared/computerControl.types'
import { brandGlyphIcon, getMainWindow } from './window'
import { createLogger } from './utils/logger'
import type { ComputerControlTarget } from './computerControl/ComputerControlTarget'
import { resolveProjectPreviewHref } from './computerControl/projectPreviewNavigation'
import { prepareHtmlPreviewSource } from './tools/previewTools'
import { withContentSecurityPolicy } from './previewContentSecurityPolicy'
import { resolveInWorkspace } from './tools/workspace'

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
/** Workspace roots are only retained for visible project preview windows. */
const previewWorkspaceRoots = new Map<string, string>()
/** Current page path for a permitted project-preview navigation session. */
const previewPagePaths = new Map<string, string>()
/** Keys currently bound to an AI-control session; navigation is stricter then. */
const controlEnabledKeys = new Set<string>()

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
export function openHtmlPreviewWindow(
  key: string,
  title: string,
  content: string,
  workspaceRoot?: string
): void {
  if (workspaceRoot) previewWorkspaceRoots.set(key, workspaceRoot)
  previewPagePaths.set(key, key)
  const existing = windows.get(key)
  if (existing && !existing.isDestroyed()) {
    existing.setTitle(title)
    void loadContent(existing, content).catch((error) =>
      log.error('Failed to load preview content:', error)
    )
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
    // The same bare glyph the main window's own title bar draws, so a pop-out
    // reads as part of Anodex sitting beside it. The previewed page never gets
    // to change it — `page-title-updated` is suppressed below for the same
    // reason.
    icon: brandGlyphIcon(),
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
    if (controlEnabledKeys.has(key)) return { action: 'deny' }
    if (/^https?:/i.test(url)) {
      shell.openExternal(url).catch((error) => log.error('Failed to open external URL:', error))
    }
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    if (controlEnabledKeys.has(key)) return
    if (/^https?:/i.test(url)) {
      shell.openExternal(url).catch((error) => log.error('Failed to open external URL:', error))
    }
  })
  // An active control session may never turn a page interaction into a file
  // transfer or an outbound request. The preview itself may have loaded
  // declared remote assets before the user enabled control; from that point
  // onward, every network request is blocked at Electron's session boundary.
  window.webContents.session.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'file://*/*', 'ftp://*/*', 'ws://*/*', 'wss://*/*'] },
    (_details, callback) => callback({ cancel: controlEnabledKeys.has(key) })
  )
  window.webContents.session.on('will-download', (event) => {
    if (controlEnabledKeys.has(key)) event.preventDefault()
  })

  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    controlEnabledKeys.delete(key)
    previewWorkspaceRoots.delete(key)
    previewPagePaths.delete(key)
    if (windows.get(key) === window) windows.delete(key)
  })

  void loadContent(window, content).catch((error) =>
    log.error('Failed to load preview content:', error)
  )
}

/** Refresh an already-open pop-out; a no-op if this file has no window up. */
export function refreshHtmlPreviewWindow(key: string, content: string): void {
  const window = windows.get(key)
  if (!window || window.isDestroyed()) return
  void loadContent(window, content).catch((error) =>
    log.error('Failed to load preview content:', error)
  )
}

/** Whether a pop-out window is currently open for this file. */
export function hasHtmlPreviewWindow(key: string): boolean {
  const window = windows.get(key)
  return Boolean(window && !window.isDestroyed())
}

/**
 * Returns a target adapter for exactly one existing preview. This intentionally
 * exposes no general BrowserWindow lookup: only a known preview key can become
 * a computer-control target.
 */
export function createHtmlPreviewControlTarget(
  key: string,
  scope: ComputerControlScope = 'single-preview'
): ComputerControlTarget | null {
  const window = windows.get(key)
  if (!window || window.isDestroyed()) return null
  return new HtmlPreviewControlTarget(key, window, scope)
}

/** Close every pop-out — called on app quit. */
export function closeHtmlPreviewWindows(): void {
  for (const window of windows.values()) {
    if (!window.isDestroyed()) window.close()
  }
  windows.clear()
  previewWorkspaceRoots.clear()
  previewPagePaths.clear()
}

function loadContent(window: BrowserWindow, content: string): Promise<void> {
  // The opaque origin a `data:` URL gives this page stops it reading anything.
  // It does not stop it *sending*: a `fetch` or an image beacon leaves happily.
  // The session-level blocker below is armed only during an AI-control
  // session, so outside one the policy is what closes that. See
  // `previewContentSecurityPolicy.ts`.
  const hardened = withContentSecurityPolicy(content)
  const dataUrl = `data:text/html;charset=utf-8;base64,${Buffer.from(hardened, 'utf-8').toString('base64')}`
  return window.loadURL(dataUrl)
}

class HtmlPreviewControlTarget implements ComputerControlTarget {
  constructor(
    private readonly key: string,
    private readonly window: BrowserWindow,
    private readonly scope: ComputerControlScope
  ) {}

  describe() {
    const bounds = this.window.getContentBounds()
    return {
      id: this.key,
      scope: this.scope,
      path: this.key,
      title: this.window.getTitle(),
      width: bounds.width,
      height: bounds.height
    }
  }

  async capture(signal: AbortSignal): Promise<ChatImageInput> {
    throwIfAborted(signal)
    if (!this.isAlive()) throw new Error('The controlled preview window was closed.')
    const image = await this.window.webContents.capturePage()
    throwIfAborted(signal)
    const png = image.toPNG()
    if (png.length === 0) throw new Error('The preview screenshot was empty.')
    return {
      path: this.key,
      name: `${this.key.replace(/[^A-Za-z0-9._-]/g, '_')}.control.png`,
      mimeType: 'image/png',
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      sizeBytes: png.length
    }
  }

  async execute(action: ValidatedComputerAction, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    if (!this.isAlive()) throw new Error('The controlled preview window was closed.')
    switch (action.type) {
      case 'screenshot':
        return
      case 'click':
        if (await this.followProjectLink(action.x, action.y, signal)) return
        this.pointer('mouseDown', action.x, action.y)
        this.pointer('mouseUp', action.x, action.y)
        return
      case 'double_click':
        if (await this.followProjectLink(action.x, action.y, signal)) return
        for (let index = 0; index < 2; index += 1) {
          this.pointer('mouseDown', action.x, action.y, 2)
          this.pointer('mouseUp', action.x, action.y, 2)
        }
        return
      case 'drag':
        this.pointer('mouseDown', action.from.x, action.from.y)
        this.pointer('mouseMove', action.to.x, action.to.y)
        await wait(action.durationMs ?? 120, signal)
        this.pointer('mouseUp', action.to.x, action.to.y)
        return
      case 'scroll':
        this.window.webContents.sendInputEvent({
          type: 'mouseWheel',
          x: 0,
          y: 0,
          deltaX: action.deltaX ?? 0,
          deltaY: action.deltaY
        })
        return
      case 'keypress':
        for (const keyCode of action.keys) {
          this.window.webContents.sendInputEvent({ type: 'keyDown', keyCode })
          this.window.webContents.sendInputEvent({ type: 'keyUp', keyCode })
        }
        return
      case 'type':
        if (await this.isSensitiveField(signal)) {
          throw new Error('Typing into password-like or secret fields is blocked.')
        }
        await this.window.webContents.insertText(action.text)
        return
      case 'wait':
        await wait(action.durationMs, signal)
    }
  }

  /** Fixed target inspection only; page-provided code is never executed here. */
  async assessAction(action: ValidatedComputerAction, signal: AbortSignal): Promise<string | null> {
    if (action.type === 'keypress' && action.keys.some((key) => key.toLowerCase() === 'enter')) {
      return 'Press Enter in the controlled preview'
    }
    if (action.type !== 'click' && action.type !== 'double_click') return null
    const result: unknown = await this.window.webContents.executeJavaScript(`(() => {
      const target = document.elementFromPoint(${action.x}, ${action.y})
      const element = target?.closest('a, button, input, [role="button"]')
      if (!element) return null
      const label = [element.textContent, element.getAttribute('aria-label'), element.getAttribute('name'), element.getAttribute('value')]
        .filter(Boolean).join(' ').replace(/\\s+/g, ' ').trim().slice(0, 120)
      const type = element instanceof HTMLInputElement ? element.type : ''
      const consequential = /save|submit|delete|remove|send|publish|pay|checkout|buy|confirm|sign|apply|reset/i.test(label) ||
        ['submit', 'reset', 'image'].includes(type) || element.tagName === 'A'
      return consequential ? (label || element.tagName.toLowerCase()) : null
    })()`)
    throwIfAborted(signal)
    return typeof result === 'string' && result
      ? `Activate “${result}” in the controlled preview`
      : null
  }

  isAlive(): boolean {
    return !this.window.isDestroyed() && windows.get(this.key) === this.window
  }

  close(): void {
    if (this.isAlive()) this.window.close()
  }

  setControlActive(active: boolean): void {
    if (active) controlEnabledKeys.add(this.key)
    else controlEnabledKeys.delete(this.key)
  }

  onClosed(listener: () => void): () => void {
    this.window.once('closed', listener)
    return () => this.window.removeListener('closed', listener)
  }

  private pointer(
    type: 'mouseDown' | 'mouseUp' | 'mouseMove',
    x: number,
    y: number,
    clickCount?: number
  ): void {
    this.window.webContents.sendInputEvent({ type, x, y, ...(clickCount ? { clickCount } : {}) })
  }

  /**
   * A project-preview session may move only to another workspace HTML page.
   * This is fixed Anodex routing; href content never becomes browser navigation
   * or a model-provided script.
   */
  private async followProjectLink(x: number, y: number, signal: AbortSignal): Promise<boolean> {
    if (this.scope !== 'project-preview') return false
    const root = previewWorkspaceRoots.get(this.key)
    const currentPath = previewPagePaths.get(this.key)
    if (!root || !currentPath) return false
    const href: unknown = await this.window.webContents.executeJavaScript(`(() => {
      const anchor = document.elementFromPoint(${x}, ${y})?.closest('a[href]')
      return anchor?.getAttribute('href') ?? null
    })()`)
    throwIfAborted(signal)
    if (typeof href !== 'string' || !href || href.startsWith('#')) return false
    const targetPath = resolveProjectPreviewHref(root, currentPath, href)
    if (!targetPath) return false
    const file = resolveInWorkspace(root, targetPath)
    const info = await stat(file)
    if (!info.isFile() || !/\.html?$/i.test(targetPath)) {
      throw new Error('Only workspace HTML pages can be opened during AI control.')
    }
    const html = await readFile(file, 'utf-8')
    const content = await prepareHtmlPreviewSource(root, targetPath, html)
    throwIfAborted(signal)
    await loadContent(this.window, content)
    previewPagePaths.set(this.key, targetPath)
    return true
  }

  /** Fixed internal inspection, never model-provided JavaScript. */
  private async isSensitiveField(signal: AbortSignal): Promise<boolean> {
    const result: unknown = await this.window.webContents.executeJavaScript(`(() => {
      const element = document.activeElement
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return false
      const label = [element.type, element.name, element.id, element.autocomplete].join(' ').toLowerCase()
      return element.type === 'password' || /pass(word)?|secret|token|api[-_ ]?key|credential/.test(label)
    })()`)
    throwIfAborted(signal)
    return result === true
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('AI control was stopped.')
}

function wait(durationMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('AI control was stopped.'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, durationMs)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new Error('AI control was stopped.'))
      },
      { once: true }
    )
  })
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
