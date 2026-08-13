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
  // Typed with the `url` argument so tests can assert on (and fetch) the
  // address the page is actually served from.
  loadURL: vi.fn<(url: string) => Promise<void>>(),
  capturePage: vi.fn<() => Promise<{ toPNG: () => Buffer }>>(),
  executeJavaScript: vi.fn<(script: string) => Promise<unknown>>(),
  onBeforeRequest: vi.fn(),
  destroy: vi.fn()
}))
const assetMocks = vi.hoisted(() => ({
  saveImage: vi.fn<() => Promise<string>>()
}))

vi.mock('electron', () => ({
  BrowserWindow: class {
    webContents = {
      setAudioMuted: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      session: { webRequest: { onBeforeRequest: electronMocks.onBeforeRequest } },
      executeJavaScript: electronMocks.executeJavaScript,
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

vi.mock('../../conversations/ConversationAssetStore', () => ({
  conversationAssetStore: { saveImage: assetMocks.saveImage }
}))

describe('inspect_visual', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'anodex-inspect-'))
    electronMocks.loadURL.mockReset().mockResolvedValue()
    electronMocks.capturePage.mockReset().mockResolvedValue({ toPNG: () => PNG })
    electronMocks.executeJavaScript
      .mockReset()
      .mockImplementation((script: string) =>
        Promise.resolve(
          script.includes('scrollHeight')
            ? { scrollHeight: 800, viewportHeight: 800 }
            : { scrollY: Number(/window\.scrollTo\(0, (\d+)\)/.exec(script)?.[1] ?? 0) }
        )
      )
    electronMocks.onBeforeRequest.mockReset()
    electronMocks.destroy.mockReset()
    assetMocks.saveImage.mockReset().mockResolvedValue('test-message-preview.png')
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('guides providers to capture the same path before and after an edit', () => {
    const tool = inspectVisualTool(createMockDefine(), createMockContext(workspace)) as unknown as {
      description: string
    }

    expect(tool.description).toContain('edit that same file in place')
    expect(tool.description).toContain('never rename, copy, or duplicate')
    expect(tool.description).toContain('Do not substitute preview_html')
    expect(tool.description).toContain('sectionId')
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
      mimeType: 'image/png',
      asset: {
        conversationId: 'test-conversation',
        id: 'test-message-preview.png'
      }
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
    // Served over loopback HTTP, not encoded into a data: URL — a data: URL has
    // an opaque origin and no base URL, which makes ES modules, import maps,
    // and relative asset paths impossible to render.
    expect(electronMocks.loadURL).toHaveBeenCalledWith(
      expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\//)
    )
    expect(visualInputs.current[0]).toMatchObject({
      name: 'page.screenshot.png',
      mimeType: 'image/png'
    })
    const preview = capture.calls.find((call) => call.status === 'success')?.preview
    expect(preview).toMatchObject({
      kind: 'image',
      title: 'Rendered page.html',
      path: 'page.html',
      asset: {
        conversationId: 'test-conversation',
        id: 'test-message-preview.png'
      }
    })
    expect(preview?.kind === 'image' ? preview.dataUrl : '').toMatch(/^data:image\/png;base64,/)
    expect(electronMocks.destroy).toHaveBeenCalled()
  })

  it('captures primary page sections and leaves room for a focused re-inspection', async () => {
    await writeFile(join(workspace, 'long-page.html'), '<main>Long visual result</main>')
    electronMocks.executeJavaScript.mockImplementation((script: string) =>
      Promise.resolve(
        script.includes('scrollHeight')
          ? {
              scrollHeight: 4000,
              viewportHeight: 800,
              sections: [
                { id: 'home', offset: 0 },
                { id: 'solar-system', offset: 800 },
                { id: 'planets', offset: 1600 },
                { id: 'facts', offset: 2400 }
              ]
            }
          : { scrollY: Number(/window\.scrollTo\(0, (\d+)\)/.exec(script)?.[1] ?? 0) }
      )
    )
    const visualInputs = createVisualInputQueue()
    const ctx = { ...createMockContext(workspace), visualInputs }
    const tool = inspectVisualTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string }) => Promise<string>
    }

    const result = await tool.handler({ path: 'long-page.html' })

    expect(result).toContain('Captured 3 primary viewport sections')
    expect(visualInputs.current.map((image) => image.name)).toEqual([
      'long-page.section-1-of-3.png',
      'long-page.section-2-of-3.png',
      'long-page.section-3-of-3.png'
    ])
    expect(electronMocks.capturePage).toHaveBeenCalledTimes(3)
    expect(electronMocks.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining('window.scrollTo(0, 800)')
    )
    expect(electronMocks.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining('window.scrollTo(0, 1600)')
    )
  })

  it('captures a named HTML section when the model needs a closer look', async () => {
    await writeFile(join(workspace, 'page.html'), '<main>Visual result</main>')
    electronMocks.executeJavaScript.mockImplementation((script: string) =>
      Promise.resolve(
        script.includes('scrollHeight')
          ? {
              scrollHeight: 2400,
              viewportHeight: 800,
              sections: [
                { id: 'home', offset: 0 },
                { id: 'solar-system', offset: 800 }
              ]
            }
          : { scrollY: Number(/window\.scrollTo\(0, (\d+)\)/.exec(script)?.[1] ?? 0) }
      )
    )
    const visualInputs = createVisualInputQueue()
    const tool = inspectVisualTool(createMockDefine(), {
      ...createMockContext(workspace),
      visualInputs
    }) as unknown as {
      handler: (args: { path: string; sectionId?: string }) => Promise<string>
    }

    const result = await tool.handler({ path: 'page.html', sectionId: 'solar-system' })

    expect(result).toContain('Captured the "solar-system" section')
    expect(visualInputs.current).toHaveLength(1)
    expect(electronMocks.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining('window.scrollTo(0, 800)')
    )
  })

  it('loads only remote assets explicitly declared by the inspected HTML', async () => {
    await writeFile(
      join(workspace, 'page.html'),
      '<script src="https://cdn.example.test/scene.js"></script><main>Visual result</main>'
    )
    const visualInputs = createVisualInputQueue()
    const tool = inspectVisualTool(createMockDefine(), {
      ...createMockContext(workspace),
      visualInputs
    }) as unknown as {
      handler: (args: { path: string }) => Promise<string>
    }

    await tool.handler({ path: 'page.html' })

    const handler = electronMocks.onBeforeRequest.mock.calls[0]?.[1] as (
      details: { url: string },
      callback: (result: { cancel: boolean }) => void
    ) => void
    const allowed = vi.fn()
    const blocked = vi.fn()
    handler({ url: 'https://cdn.example.test/scene.js' }, allowed)
    handler({ url: 'https://unrelated.example.test/tracker.js' }, blocked)

    expect(allowed).toHaveBeenCalledWith({ cancel: false })
    expect(blocked).toHaveBeenCalledWith({ cancel: true })
  })

  /**
   * The driving incident in one test: a page whose only dependency is declared
   * inside an import map. The previous attribute-only allowlist was empty for
   * this page, so every module request was cancelled and the canvas was blank
   * in every inspection regardless of the project's own code.
   */
  it('allows import-map modules and reports what it blocked', async () => {
    await writeFile(
      join(workspace, 'page.html'),
      `<head><script type="importmap">
      { "imports": {
          "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
          "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"
      } }
      </script></head>
      <body><canvas id="sandboxCanvas"></canvas>
      <script type="module" src="js/sandbox.js"></script></body>`
    )
    const visualInputs = createVisualInputQueue()
    const tool = inspectVisualTool(createMockDefine(), {
      ...createMockContext(workspace),
      visualInputs
    }) as unknown as {
      handler: (args: { path: string }) => Promise<string>
    }

    const result = await tool.handler({ path: 'page.html' })

    const handler = electronMocks.onBeforeRequest.mock.calls[0]?.[1] as (
      details: { url: string },
      callback: (result: { cancel: boolean }) => void
    ) => void
    const bareSpecifier = vi.fn()
    const prefixSubmodule = vi.fn()
    const undeclared = vi.fn()
    handler(
      { url: 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js' },
      bareSpecifier
    )
    handler(
      { url: 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js' },
      prefixSubmodule
    )
    handler({ url: 'https://tracker.example.test/beacon.js' }, undeclared)

    expect(bareSpecifier).toHaveBeenCalledWith({ cancel: false })
    // Resolved through the `three/addons/` prefix mapping — this URL appears
    // verbatim nowhere in the document.
    expect(prefixSubmodule).toHaveBeenCalledWith({ cancel: false })
    expect(undeclared).toHaveBeenCalledWith({ cancel: true })
    expect(result).toContain('attached to the next model round')
  })

  it('injects the diagnostics collector into the served document', async () => {
    await writeFile(join(workspace, 'page.html'), '<head></head><body><main>Hi</main></body>')
    const visualInputs = createVisualInputQueue()
    const tool = inspectVisualTool(createMockDefine(), {
      ...createMockContext(workspace),
      visualInputs
    }) as unknown as {
      handler: (args: { path: string }) => Promise<string>
    }

    // Fetch while the server is still alive — it is torn down as soon as the
    // capture finishes (see the teardown test below).
    let served = ''
    electronMocks.loadURL.mockImplementation(async (url: string) => {
      served = await fetch(url).then((response) => response.text())
    })

    await tool.handler({ path: 'page.html' })

    expect(served).toContain('__anodexDiagnostics')
    expect(served).toContain('<main>Hi</main>')
    // The collector must precede page content so an exception thrown during
    // initial module evaluation is captured rather than missed.
    expect(served.indexOf('__anodexDiagnostics')).toBeLessThan(served.indexOf('<main>Hi</main>'))
  })

  it('tears the inspection server down after the capture', async () => {
    await writeFile(join(workspace, 'page.html'), '<main>Visual result</main>')
    const visualInputs = createVisualInputQueue()
    const tool = inspectVisualTool(createMockDefine(), {
      ...createMockContext(workspace),
      visualInputs
    }) as unknown as {
      handler: (args: { path: string }) => Promise<string>
    }

    await tool.handler({ path: 'page.html' })
    const url = electronMocks.loadURL.mock.calls[0]?.[0]

    expect(url).toBeDefined()
    await expect(fetch(url ?? '')).rejects.toThrow()
  })
})
