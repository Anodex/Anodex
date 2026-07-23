import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inspectVisualTool } from '../visualInspectionTools'
import { createVisualInputQueue } from '../../vision/imageInputs'
import { captureCalls, createMockContext, createMockDefine } from './test-helpers'

const PNG = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  Buffer.from('captured-pixels')
])

const electronMocks = vi.hoisted(() => ({
  loadURL: vi.fn<() => Promise<void>>(),
  capturePage: vi.fn<() => Promise<{ toPNG: () => Buffer }>>(),
  destroy: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: class {
    webContents = {
      setAudioMuted: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      session: { webRequest: { onBeforeRequest: vi.fn() } },
      capturePage: electronMocks.capturePage
    }

    loadURL = electronMocks.loadURL
    isDestroyed = (): boolean => false
    destroy = electronMocks.destroy
  }
}))

vi.mock('../../projects/ProjectMemoryStore', () => ({
  projectMemoryStore: { recordTouch: vi.fn() }
}))

describe('inspect_visual', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'anodex-inspect-'))
    electronMocks.loadURL.mockReset().mockResolvedValue()
    electronMocks.capturePage.mockReset().mockResolvedValue({ toPNG: () => PNG })
    electronMocks.destroy.mockReset()
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('queues an existing workspace image for the provider next round', async () => {
    await writeFile(join(workspace, 'result.png'), PNG)
    const visualInputs = createVisualInputQueue()
    const capture = captureCalls()
    const ctx = { ...createMockContext(workspace), visualInputs, emit: capture.emit }
    const tool = inspectVisualTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string }) => Promise<string>
    }

    const result = await tool.handler({ path: 'result.png' })

    expect(result).toContain('attached to the next model round')
    expect(visualInputs.current).toHaveLength(1)
    expect(visualInputs.current[0]).toMatchObject({
      name: 'result.png',
      mimeType: 'image/png'
    })
    const preview = capture.calls.find((call) => call.status === 'success')?.preview
    expect(preview).toMatchObject({
      kind: 'image',
      path: 'result.png',
      mimeType: 'image/png'
    })
  })

  it('renders confined HTML to a PNG and queues the screenshot', async () => {
    await writeFile(join(workspace, 'page.html'), '<main>Visual result</main>')
    const visualInputs = createVisualInputQueue()
    const capture = captureCalls()
    const ctx = { ...createMockContext(workspace), visualInputs, emit: capture.emit }
    const tool = inspectVisualTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string }) => Promise<string>
    }

    const result = await tool.handler({ path: 'page.html' })

    expect(result).toContain('attached to the next model round')
    expect(electronMocks.loadURL).toHaveBeenCalledWith(expect.stringMatching(/^data:text\/html/))
    expect(visualInputs.current[0]).toMatchObject({
      name: 'page.screenshot.png',
      mimeType: 'image/png'
    })
    const preview = capture.calls.find((call) => call.status === 'success')?.preview
    expect(preview).toMatchObject({
      kind: 'image',
      title: 'Rendered page.html',
      path: 'page.html'
    })
    expect(preview?.kind === 'image' ? preview.dataUrl : '').toMatch(/^data:image\/png;base64,/)
    expect(electronMocks.destroy).toHaveBeenCalled()
  })
})
