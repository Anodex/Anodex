import { BrowserWindow, screen } from 'electron'
import type { ComputerControlSession } from '@shared/computerControl.types'
import { computerControlService } from './ComputerControlService'
import { getMainWindow } from '../window'

interface OverlayEntry {
  window: BrowserWindow
  closing: boolean
}

/**
 * A native, always-on-top control strip that stays visible beside every active
 * Anodex control session. It is deliberately a tiny isolated document with no
 * preload; its two links are intercepted by this owner and never become web
 * navigation.
 */
class ControlOverlayWindow {
  private readonly overlays = new Map<string, OverlayEntry>()

  constructor() {
    computerControlService.on('changed', (session: ComputerControlSession) => this.sync(session))
  }

  sync(session: ComputerControlSession): void {
    if (session.status === 'ended') {
      this.close(session.conversationId)
      return
    }
    const entry = this.overlays.get(session.conversationId)
    if (entry && !entry.window.isDestroyed()) {
      this.load(entry.window, session)
      return
    }
    const window = new BrowserWindow({
      ...overlayBounds(),
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      backgroundColor: '#12151d',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    this.overlays.set(session.conversationId, { window, closing: false })
    window.setAlwaysOnTop(true, 'screen-saver')
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event, url) => {
      event.preventDefault()
      const action = actionFromOverlayUrl(url)
      if (action === 'pause') computerControlService.pause(session.conversationId)
      if (action === 'resume') computerControlService.resume(session.conversationId)
      if (action === 'stop')
        computerControlService.stopConversation(session.conversationId, 'user-stop')
    })
    window.once('ready-to-show', () => window.showInactive())
    window.on('closed', () => {
      const current = this.overlays.get(session.conversationId)
      if (!current || current.window !== window) return
      this.overlays.delete(session.conversationId)
      if (!current.closing && computerControlService.get(session.conversationId)) {
        computerControlService.stopConversation(session.conversationId, 'user-stop')
      }
    })
    this.load(window, session)
  }

  private close(conversationId: string): void {
    const entry = this.overlays.get(conversationId)
    if (!entry) return
    this.overlays.delete(conversationId)
    entry.closing = true
    if (!entry.window.isDestroyed()) entry.window.close()
  }

  private load(window: BrowserWindow, session: ComputerControlSession): void {
    const action = session.status === 'paused' ? 'resume' : 'pause'
    const label = session.status === 'paused' ? 'Resume' : 'Pause'
    const target = escapeHtml(session.target.title || session.target.path)
    const content = `<!doctype html><html><head><meta charset="utf-8"><style>
      *{box-sizing:border-box}body{margin:0;display:flex;align-items:center;gap:10px;min-height:76px;padding:12px 14px;color:#e8ebf0;background:#12151d;font:12px system-ui,sans-serif;border:1px solid #42516b;border-radius:10px}
      .status{display:grid;gap:3px;min-width:0;flex:1}.title{font-weight:700}.meta{overflow:hidden;color:#aeb8c8;text-overflow:ellipsis;white-space:nowrap}a{padding:7px 10px;border-radius:6px;color:#e8ebf0;background:#243047;text-decoration:none;font-weight:700}a.stop{background:#9d3846}
    </style></head><body><div class="status"><span class="title">AI control ${session.status}</span><span class="meta">${target} · ${session.budget.actionsUsed}/${session.budget.actionLimit} actions</span></div><a href="https://anodex-control.local/${action}">${label}</a><a class="stop" href="https://anodex-control.local/stop">Stop</a></body></html>`
    const dataUrl = `data:text/html;charset=utf-8;base64,${Buffer.from(content, 'utf-8').toString('base64')}`
    void window.webContents.loadURL(dataUrl).catch(() => {})
  }
}

function actionFromOverlayUrl(url: string): 'pause' | 'resume' | 'stop' | null {
  try {
    const parsed = new URL(url)
    if (parsed.origin !== 'https://anodex-control.local') return null
    if (parsed.pathname === '/pause') return 'pause'
    if (parsed.pathname === '/resume') return 'resume'
    if (parsed.pathname === '/stop') return 'stop'
  } catch {
    // Only an internally generated fixed URL can activate the overlay.
  }
  return null
}

function overlayBounds(): { x: number; y: number; width: number; height: number } {
  const main = getMainWindow()
  const display = main ? screen.getDisplayMatching(main.getBounds()) : screen.getPrimaryDisplay()
  const area = display.workArea
  return {
    x: Math.max(area.x, area.x + area.width - 400),
    y: area.y + 20,
    width: 380,
    height: 76
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    if (char === '&') return '&amp;'
    if (char === '<') return '&lt;'
    if (char === '>') return '&gt;'
    if (char === '"') return '&quot;'
    return '&#39;'
  })
}

export const computerControlOverlay = new ControlOverlayWindow()
