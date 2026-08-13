import type { ChatImageInput } from '@shared/chat.types'
import type { ValidatedComputerAction } from '@shared/computerControl.types'
import type { ComputerControlTarget } from './ComputerControlTarget'
import type { DesktopWindowTarget } from './WindowsDesktopControlBackend'
import { WindowsDesktopControlBackend } from './WindowsDesktopControlBackend'

/** A one-window desktop target. Every action is human-confirmed by the tool layer. */
export class WindowsDesktopControlTarget implements ComputerControlTarget {
  constructor(
    private readonly target: DesktopWindowTarget,
    private readonly backend: WindowsDesktopControlBackend
  ) {}

  describe() {
    return {
      id: `desktop:${this.target.handle}`,
      scope: 'desktop' as const,
      path: this.target.processPath,
      title: this.target.title,
      width: this.target.bounds.width,
      height: this.target.bounds.height
    }
  }

  async capture(signal: AbortSignal): Promise<ChatImageInput> {
    const screenshot = await this.backend.capture(this.target, signal)
    return {
      path: this.target.processPath,
      name: 'desktop-control.png',
      mimeType: screenshot.mimeType,
      dataUrl: screenshot.dataUrl,
      sizeBytes: Math.ceil((screenshot.dataUrl.length * 3) / 4)
    }
  }

  async execute(action: ValidatedComputerAction, signal: AbortSignal): Promise<void> {
    await this.backend.execute(this.target, toScreenAction(action, this.target.bounds), signal)
  }

  assessAction(action: ValidatedComputerAction): Promise<string> {
    return Promise.resolve(`Approve ${describeDesktopAction(action)} in “${this.target.title}”`)
  }

  isAlive(): boolean {
    // The native bridge revalidates handle, PID, and executable before every capture/action.
    return true
  }

  close(): void {
    // The user owns the selected desktop app; control must never close it.
  }
}

function describeDesktopAction(action: ValidatedComputerAction): string {
  if (action.type === 'type') return `typing ${action.text.length} characters`
  if (action.type === 'keypress') return `pressing ${action.keys.join(' + ')}`
  if (action.type === 'click' || action.type === 'double_click')
    return `${action.type.replace('_', ' ')} at ${action.x}, ${action.y}`
  return action.type.replace('_', ' ')
}

function toScreenAction(
  action: ValidatedComputerAction,
  bounds: DesktopWindowTarget['bounds']
): ValidatedComputerAction {
  if (action.type === 'click' || action.type === 'double_click') {
    return { ...action, x: action.x + bounds.x, y: action.y + bounds.y }
  }
  if (action.type === 'drag') {
    return {
      ...action,
      from: { x: action.from.x + bounds.x, y: action.from.y + bounds.y },
      to: { x: action.to.x + bounds.x, y: action.to.y + bounds.y }
    }
  }
  return action
}
