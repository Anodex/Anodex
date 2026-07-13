import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import type { ToastContent } from '@shared/toast.types'
import { getMainWindow } from './window'
import { createLogger } from './utils/logger'

const log = createLogger('toast-window')

/**
 * Desktop toast rendered as a real, app-controlled window rather than the OS's
 * native `Notification` — same approach as the Anodex2 (Tauri) sibling
 * project's `notifications.rs`: a frameless, transparent, always-on-top,
 * non-focusable window loading a small dedicated page, positioned in the
 * bottom-right corner and closed automatically after a few seconds. Unlike a
 * native OS toast, this one is real HTML/CSS Anodex fully controls, so it can
 * actually match the app's own theme instead of the OS's generic chrome.
 */
const TOAST_WIDTH = 360
// Tall enough for the worst case — eyebrow + title + a wrapped 2-line body —
// plus the card's own padding and the outer shadow margin in ToastWindow.tsx.
// 100px used to clip the bottom of the card when the body wrapped to 2 lines.
const TOAST_HEIGHT = 128
const MARGIN_RIGHT = 24
const MARGIN_BOTTOM = 72
/**
 * `ToastWindow.tsx` owns the real dismiss timing (a visible period, then its
 * own fade-out) and closes itself. This is only a backstop for the rare case
 * where that JS never runs (a load error, a slow/blocked renderer) — kept
 * comfortably longer than the renderer's own ~5s total so it never preempts
 * the normal close, and started from `show` rather than window creation so
 * dev-mode load time (loading over HTTP from the Vite dev server, unlike the
 * near-instant `loadFile` in production) doesn't eat into either budget.
 */
const FALLBACK_CLOSE_MS = 7000

/** Only one toast at a time — a new one replaces whatever is still showing. */
let activeToast: BrowserWindow | null = null

/** Close the active toast, if any — called on app quit. */
export function closeToast(): void {
  if (activeToast && !activeToast.isDestroyed()) activeToast.close()
}

export function showToastWindow(content: ToastContent): void {
  if (activeToast && !activeToast.isDestroyed()) activeToast.close()

  const toast = new BrowserWindow({
    width: TOAST_WIDTH,
    height: TOAST_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    focusable: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  activeToast = toast

  positionToast(toast)

  const query: Record<string, string> = {
    mode: 'toast',
    title: content.title,
    body: content.body,
    ...(content.conversationId ? { conversationId: content.conversationId } : {})
  }
  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl) {
    toast
      .loadURL(`${devServerUrl}?${new URLSearchParams(query).toString()}`)
      .catch((error) => log.error('Failed to load toast dev server URL:', error))
  } else {
    toast
      .loadFile(join(__dirname, '../renderer/index.html'), { query })
      .catch((error) => log.error('Failed to load toast index.html:', error))
  }

  let fallbackTimer: ReturnType<typeof setTimeout> | undefined
  toast.once('ready-to-show', () => {
    toast.show()
    fallbackTimer = setTimeout(() => {
      if (!toast.isDestroyed()) toast.close()
    }, FALLBACK_CLOSE_MS)
  })

  toast.on('closed', () => {
    clearTimeout(fallbackTimer)
    if (activeToast === toast) activeToast = null
  })
}

/**
 * Bottom-right corner of whichever display the main window is currently on
 * (falling back to the primary display if it isn't open) — not always the
 * primary display, so the toast doesn't appear on a monitor the user isn't
 * looking at on a multi-monitor setup.
 */
function positionToast(toast: BrowserWindow): void {
  const mainWindow = getMainWindow()
  const display = mainWindow
    ? screen.getDisplayMatching(mainWindow.getBounds())
    : screen.getPrimaryDisplay()
  const { x, y, width, height } = display.workArea
  toast.setPosition(
    x + width - TOAST_WIDTH - MARGIN_RIGHT,
    y + height - TOAST_HEIGHT - MARGIN_BOTTOM
  )
}
