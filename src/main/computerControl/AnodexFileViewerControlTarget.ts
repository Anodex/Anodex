import type { BrowserWindow } from 'electron'
import type { ChatImageInput } from '@shared/chat.types'
import type { ValidatedComputerAction } from '@shared/computerControl.types'
import { getMainWindow } from '../window'
import type { ComputerControlTarget } from './ComputerControlTarget'

const SURFACE_TARGET = {
  mode: 'file-viewer-mode',
  editor: 'file-viewer-editor',
  save: 'file-viewer-save'
} as const

const EDITOR_KEYS = new Set([
  'Backspace',
  'Delete',
  'Tab',
  'Enter',
  'Up',
  'Down',
  'Left',
  'Right',
  'Home',
  'End'
])

type SurfaceTargetId = (typeof SURFACE_TARGET)[keyof typeof SURFACE_TARGET]

/**
 * Anodex-owned control is deliberately selector-based, not a general main-window
 * input channel. Only controls explicitly tagged in the renderer can receive a
 * pointer event, making the DOM allowlist the safety boundary.
 */
export class AnodexFileViewerControlTarget implements ComputerControlTarget {
  constructor(private readonly window: BrowserWindow) {}

  describe() {
    const bounds = this.window.getContentBounds()
    return {
      id: 'anodex:file-viewer',
      scope: 'anodex-file-viewer' as const,
      path: 'anodex/file-viewer',
      title: 'Anodex File Viewer',
      width: bounds.width,
      height: bounds.height
    }
  }

  async capture(signal: AbortSignal): Promise<ChatImageInput> {
    throwIfAborted(signal)
    if (!this.isAlive()) throw new Error('The Anodex File Viewer is no longer available.')
    const image = await this.window.webContents.capturePage()
    throwIfAborted(signal)
    const png = image.toPNG()
    if (png.length === 0) throw new Error('The Anodex surface screenshot was empty.')
    return {
      path: 'anodex/file-viewer',
      name: 'anodex-file-viewer.control.png',
      mimeType: 'image/png',
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      sizeBytes: png.length
    }
  }

  async execute(action: ValidatedComputerAction, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    if (!this.isAlive()) throw new Error('The Anodex File Viewer is no longer available.')
    switch (action.type) {
      case 'screenshot':
        return
      case 'click':
        await this.assertAllowedPoint(action.x, action.y, Object.values(SURFACE_TARGET), signal)
        this.pointer('mouseDown', action.x, action.y)
        this.pointer('mouseUp', action.x, action.y)
        return
      case 'double_click':
        await this.assertAllowedPoint(action.x, action.y, Object.values(SURFACE_TARGET), signal)
        for (let index = 0; index < 2; index += 1) {
          this.pointer('mouseDown', action.x, action.y, 2)
          this.pointer('mouseUp', action.x, action.y, 2)
        }
        return
      case 'drag':
        await this.assertAllowedPoint(action.from.x, action.from.y, [SURFACE_TARGET.editor], signal)
        await this.assertAllowedPoint(action.to.x, action.to.y, [SURFACE_TARGET.editor], signal)
        this.pointer('mouseDown', action.from.x, action.from.y)
        this.pointer('mouseMove', action.to.x, action.to.y)
        this.pointer('mouseUp', action.to.x, action.to.y)
        return
      case 'keypress':
        await this.assertActiveTarget([SURFACE_TARGET.editor], signal)
        assertSafeEditorKeys(action.keys)
        for (const keyCode of action.keys) {
          this.window.webContents.sendInputEvent({ type: 'keyDown', keyCode })
          this.window.webContents.sendInputEvent({ type: 'keyUp', keyCode })
        }
        return
      case 'type':
        await this.assertActiveTarget([SURFACE_TARGET.editor], signal)
        await this.window.webContents.insertText(action.text)
        return
      case 'wait':
        await wait(action.durationMs, signal)
        return
      default:
        throw new Error('This Anodex surface does not permit that action.')
    }
  }

  async assessAction(action: ValidatedComputerAction, signal: AbortSignal): Promise<string | null> {
    if (action.type === 'click' || action.type === 'double_click') {
      const target = await this.assertAllowedPoint(
        action.x,
        action.y,
        Object.values(SURFACE_TARGET),
        signal
      )
      if (target === SURFACE_TARGET.save) return 'Save the current file in Anodex File Viewer'
      return null
    }
    if (action.type === 'drag') {
      await this.assertAllowedPoint(action.from.x, action.from.y, [SURFACE_TARGET.editor], signal)
      await this.assertAllowedPoint(action.to.x, action.to.y, [SURFACE_TARGET.editor], signal)
      return null
    }
    if (action.type === 'keypress') {
      await this.assertActiveTarget([SURFACE_TARGET.editor], signal)
      assertSafeEditorKeys(action.keys)
      return `Press ${action.keys.join(' + ')} in the Anodex File Viewer editor`
    }
    if (action.type === 'type') {
      await this.assertActiveTarget([SURFACE_TARGET.editor], signal)
      return `Type ${action.text.length} characters in the Anodex File Viewer editor`
    }
    if (!['screenshot', 'wait'].includes(action.type)) {
      throw new Error('This Anodex surface does not permit that action.')
    }
    return null
  }

  isAlive(): boolean {
    return !this.window.isDestroyed() && getMainWindow() === this.window
  }

  close(): void {
    // The Anodex main window belongs to the user; a control session must never close it.
  }

  onClosed(listener: () => void): () => void {
    this.window.once('closed', listener)
    return () => this.window.removeListener('closed', listener)
  }

  private async assertAllowedPoint(
    x: number,
    y: number,
    allowed: readonly SurfaceTargetId[],
    signal: AbortSignal
  ): Promise<SurfaceTargetId> {
    const target: unknown = await this.window.webContents.executeJavaScript(`(() => {
      const element = document.elementFromPoint(${x}, ${y})?.closest('[data-computer-control-target]')
      if (!element) return null
      return element.getAttribute('data-computer-control-target')
    })()`)
    throwIfAborted(signal)
    if (typeof target !== 'string' || !allowed.includes(target as SurfaceTargetId)) {
      throw new Error('That Anodex control is outside the enabled File Viewer surface.')
    }
    return target as SurfaceTargetId
  }

  private async assertActiveTarget(
    allowed: readonly SurfaceTargetId[],
    signal: AbortSignal
  ): Promise<SurfaceTargetId> {
    const target: unknown = await this.window.webContents.executeJavaScript(`(() => {
      const element = document.activeElement?.closest?.('[data-computer-control-target]')
      return element?.getAttribute('data-computer-control-target') ?? null
    })()`)
    throwIfAborted(signal)
    if (typeof target !== 'string' || !allowed.includes(target as SurfaceTargetId)) {
      throw new Error('Focus the enabled Anodex File Viewer editor before typing or pressing keys.')
    }
    return target as SurfaceTargetId
  }

  private pointer(
    type: 'mouseDown' | 'mouseUp' | 'mouseMove',
    x: number,
    y: number,
    clickCount?: number
  ): void {
    this.window.webContents.sendInputEvent({ type, x, y, ...(clickCount ? { clickCount } : {}) })
  }
}

function assertSafeEditorKeys(keys: string[]): void {
  if (keys.length !== 1 || !EDITOR_KEYS.has(keys[0])) {
    throw new Error('This Anodex surface permits only one safe editor navigation or editing key.')
  }
}

export function createAnodexFileViewerControlTarget(): ComputerControlTarget | null {
  const window = getMainWindow()
  if (!window || window.isDestroyed()) return null
  return new AnodexFileViewerControlTarget(window)
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
