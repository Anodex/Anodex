import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ComputerAction, DesktopControlWindowInfo } from '@shared/computerControl.types'

const HELPER_TIMEOUT_MS = 15_000

export type DesktopWindowTarget = DesktopControlWindowInfo

interface HelperResponse<T> {
  ok: boolean
  value?: T
  error?: string
}

interface HelperCapture {
  mimeType: string
  dataBase64: string
  width: number
  height: number
}

/**
 * The only desktop bridge. It sends a fixed JSON request to the packaged native
 * helper and never invokes a shell, script, URL, or model-provided executable.
 */
export class WindowsDesktopControlBackend {
  isAvailable(): boolean {
    return process.platform === 'win32' && existsSync(helperPath())
  }

  async listWindows(signal?: AbortSignal): Promise<DesktopWindowTarget[]> {
    this.requireAvailable()
    const targets = await this.run<DesktopWindowTarget[]>({ command: 'list-windows' }, signal)
    return targets.filter((target) => isEligibleDesktopWindow(target))
  }

  async capture(
    target: DesktopWindowTarget,
    signal?: AbortSignal
  ): Promise<{
    dataUrl: string
    mimeType: string
    width: number
    height: number
  }> {
    await this.assertStillEligible(target, signal)
    const capture = await this.run<HelperCapture>(
      { command: 'capture', handle: target.handle },
      signal
    )
    return {
      dataUrl: `data:${capture.mimeType};base64,${capture.dataBase64}`,
      mimeType: capture.mimeType,
      width: capture.width,
      height: capture.height
    }
  }

  async execute(
    target: DesktopWindowTarget,
    action: ComputerAction,
    signal?: AbortSignal
  ): Promise<void> {
    await this.assertStillEligible(target, signal)
    await this.run<Record<string, never>>(
      { command: 'execute', handle: target.handle, action },
      signal
    )
  }

  private async assertStillEligible(
    target: DesktopWindowTarget,
    signal?: AbortSignal
  ): Promise<void> {
    const current = await this.listWindows(signal)
    const match = current.find(
      (candidate) =>
        candidate.handle === target.handle &&
        candidate.processId === target.processId &&
        candidate.processPath === target.processPath &&
        sameBounds(candidate.bounds, target.bounds)
    )
    if (!match) {
      throw new Error('The approved desktop window moved, changed, or is no longer available.')
    }
  }

  private async run<T>(request: object, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new Error('AI control was stopped.')
    return await new Promise<T>((resolve, reject) => {
      const child = spawn(helperPath(), [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => child.kill(), HELPER_TIMEOUT_MS)
      const abort = (): void => {
        child.kill()
      }
      signal?.addEventListener('abort', abort, { once: true })
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk
      })
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk
      })
      child.once('error', reject)
      child.once('exit', (code) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        if (signal?.aborted) return reject(new Error('AI control was stopped.'))
        if (code !== 0) return reject(new Error(stderr.trim() || 'Desktop-control helper failed.'))
        try {
          const response = JSON.parse(stdout) as HelperResponse<T>
          if (!response.ok || response.value === undefined) {
            reject(new Error(response.error || 'Desktop-control helper rejected the request.'))
            return
          }
          resolve(response.value)
        } catch {
          reject(new Error('Desktop-control helper returned an invalid response.'))
        }
      })
      child.stdin.end(JSON.stringify(request))
    })
  }

  private requireAvailable(): void {
    if (!this.isAvailable()) {
      throw new Error('The packaged Windows desktop-control helper is not available.')
    }
  }
}

export const windowsDesktopControlBackend = new WindowsDesktopControlBackend()

export function isEligibleDesktopWindow(target: DesktopWindowTarget): boolean {
  const executable = target.processPath.split(/[\\/]/).at(-1)?.toLowerCase() ?? ''
  const title = target.title.toLowerCase()
  if (!target.title.trim() || target.bounds.width < 100 || target.bounds.height < 100) return false
  // Anodex surfaces use their own tagged adapters. Letting the generic native
  // backend select our own window would bypass that allowlist entirely.
  if (
    target.processId === process.pid ||
    target.processPath.replaceAll('\\', '/').toLowerCase() ===
      process.execPath.replaceAll('\\', '/').toLowerCase()
  ) {
    return false
  }
  if (
    [
      'logonui.exe',
      'credentialuibroker.exe',
      'consent.exe',
      'lockapp.exe',
      'winlogon.exe',
      'useroobebroker.exe'
    ].includes(executable)
  ) {
    return false
  }
  if (
    ['1password', 'bitwarden', 'keepass', 'lastpass', 'dashlane'].some((name) =>
      title.includes(name)
    )
  ) {
    return false
  }
  return !/(password|passcode|sign[ -]?in|log[ -]?in|checkout|payment|bank|wallet|account recovery|two[ -]?factor|verification code)/.test(
    title
  )
}

function sameBounds(
  left: DesktopWindowTarget['bounds'],
  right: DesktopWindowTarget['bounds']
): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  )
}

function helperPath(): string {
  const base = process.resourcesPath || join(process.cwd(), 'resources')
  return join(base, 'windows-control', 'win32-x64', 'Anodex.WindowsControl.exe')
}
