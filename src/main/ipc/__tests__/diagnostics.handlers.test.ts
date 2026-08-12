import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IpcChannel } from '@shared/ipc'
import type { SupportBundlePreview } from '@shared/supportBundle.types'

type Handler = (event: { sender: unknown }, ...args: never[]) => unknown
interface SaveDialogResult {
  canceled: boolean
  filePath?: string
}

const handlers = new Map<string, Handler>()
const showSaveDialog = vi.fn<(options: unknown) => Promise<SaveDialogResult>>()
const writeFile = vi.fn<(path: string, content: string, encoding: string) => Promise<void>>()

vi.mock('electron', () => ({
  app: { getPath: () => 'C:\\Documents' },
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showSaveDialog: (options: unknown) => showSaveDialog(options) },
  ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
  shell: { showItemInFolder: vi.fn() }
}))
vi.mock('node:fs/promises', () => ({
  writeFile: (path: string, content: string, encoding: string) => writeFile(path, content, encoding)
}))
vi.mock('../../diagnostics/DiagnosticsReporter', () => ({ diagnosticsReporter: { list: vi.fn() } }))
vi.mock('../../diagnostics/logFile', () => ({ getLogFileInfo: vi.fn() }))

const createSupportBundlePreview = vi.fn<() => Promise<SupportBundlePreview>>()
vi.mock('../../diagnostics/SupportBundleService', () => ({
  createSupportBundlePreview: () => createSupportBundlePreview()
}))

const { registerDiagnosticsHandlers } = await import('../diagnostics.handlers')

const preview: SupportBundlePreview = {
  fileName: 'anodex-support-2026-01-02.txt',
  content: 'redacted report',
  diagnosticsCount: 2,
  logLineCount: 4,
  redactionCount: 3
}

function invoke(channel: string): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`No handler registered for ${channel}`)
  return Promise.resolve(handler({ sender: {} }))
}

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  createSupportBundlePreview.mockResolvedValue(preview)
  showSaveDialog.mockResolvedValue({ canceled: false, filePath: 'C:\\Reports\\bundle' })
  writeFile.mockResolvedValue(undefined)
  registerDiagnosticsHandlers()
})

describe('support bundle handlers', () => {
  it('returns the redacted preview from the main process', async () => {
    await expect(invoke(IpcChannel.Diagnostics.getSupportBundlePreview)).resolves.toEqual({
      ok: true,
      value: preview
    })
  })

  it('only writes after a native save location is chosen and adds the text extension', async () => {
    await expect(invoke(IpcChannel.Diagnostics.saveSupportBundle)).resolves.toEqual({
      ok: true,
      value: { path: 'C:\\Reports\\bundle.txt' }
    })

    expect(writeFile).toHaveBeenCalledWith('C:\\Reports\\bundle.txt', 'redacted report', 'utf-8')
  })

  it('does not write anything when the user cancels', async () => {
    showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined })

    await expect(invoke(IpcChannel.Diagnostics.saveSupportBundle)).resolves.toEqual({
      ok: true,
      value: { path: null }
    })
    expect(writeFile).not.toHaveBeenCalled()
  })
})
