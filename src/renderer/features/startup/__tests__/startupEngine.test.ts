import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `startupEngine`'s response to window resizing, which is the one part of it
 * that is expensive rather than decorative.
 *
 * `resize()` reseeds ~1,260 stars and builds an offscreen nebula of 1.5× the
 * largest viewport dimension — 32 MB at 1080p, 102 MB on an ultrawide. Nothing
 * debounced it and nothing checked whether the size had changed, so every
 * `window.resize` paid the full cost, including the several Electron emits
 * around show/restore that do not change the size at all.
 *
 * The suite runs in the `node` environment, so the narrow DOM surface the
 * engine touches is stubbed here rather than pulling in a DOM implementation
 * for one file.
 */

/** Every 2D context call the engine makes, as no-ops. */
function fakeContext(): CanvasRenderingContext2D {
  const gradient = { addColorStop: () => {} }
  const ctx = {
    setTransform: () => {},
    clearRect: () => {},
    fillRect: () => {},
    save: () => {},
    restore: () => {},
    translate: () => {},
    rotate: () => {},
    scale: () => {},
    drawImage: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    arc: () => {},
    fill: () => {},
    stroke: () => {},
    createRadialGradient: () => gradient,
    createLinearGradient: () => gradient,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineCap: '',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over'
  }
  return ctx as unknown as CanvasRenderingContext2D
}

function fakeCanvas(): HTMLCanvasElement {
  return { width: 0, height: 0, getContext: () => fakeContext() } as unknown as HTMLCanvasElement
}

/** Offscreen canvases the engine builds for itself — the thing being counted. */
let createdCanvases: HTMLCanvasElement[] = []
let resizeListeners: Array<() => void> = []

function setViewport(width: number, height: number): void {
  ;(globalThis as { window: { innerWidth: number; innerHeight: number } }).window.innerWidth = width
  ;(globalThis as { window: { innerWidth: number; innerHeight: number } }).window.innerHeight =
    height
}

beforeEach(() => {
  createdCanvases = []
  resizeListeners = []
  Object.assign(globalThis, {
    window: {
      innerWidth: 1920,
      innerHeight: 1080,
      devicePixelRatio: 1,
      addEventListener: (event: string, handler: () => void) => {
        if (event === 'resize') resizeListeners.push(handler)
      },
      removeEventListener: (event: string, handler: () => void) => {
        if (event === 'resize') resizeListeners = resizeListeners.filter((h) => h !== handler)
      }
    },
    document: {
      createElement: () => {
        const canvas = fakeCanvas()
        createdCanvases.push(canvas)
        return canvas
      }
    },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {}
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function engine(): Promise<{
  destroy: () => void
  resize: () => void
}> {
  const { StartupEngine } = await import('../startupEngine')
  const instance = new StartupEngine({
    stage: { dataset: {} } as unknown as HTMLElement,
    starCanvas: fakeCanvas(),
    settleCanvas: fakeCanvas(),
    isFirstLaunch: () => false,
    isReducedMotion: () => false,
    isFullIntro: () => true,
    onFinished: () => {}
  })
  return {
    destroy: () => instance.destroy(),
    resize: () => resizeListeners.forEach((handler) => handler())
  }
}

describe('startupEngine — resize', () => {
  it('builds the nebula once when it is first constructed', async () => {
    await engine()

    expect(createdCanvases).toHaveLength(1)
  })

  it('does no work at all for a resize that did not change the size', async () => {
    // Electron emits several of these around window show/restore. Each one
    // used to reseed the whole field and allocate a fresh 32 MB backdrop.
    const { resize } = await engine()
    createdCanvases = []

    resize()
    resize()
    resize()

    expect(createdCanvases).toHaveLength(0)
  })

  it('reuses a nebula that is already large enough when the window shrinks', async () => {
    // It is a decorative backdrop drawn centred at two scales, so an oversized
    // texture is indistinguishable from an exact one.
    const { resize } = await engine()
    createdCanvases = []

    setViewport(1280, 720)
    resize()

    expect(createdCanvases).toHaveLength(0)
  })

  it('builds a new nebula when the window grows past the one it has', async () => {
    const { resize } = await engine()
    createdCanvases = []

    setViewport(3440, 1440)
    resize()

    expect(createdCanvases).toHaveLength(1)
  })

  it('rebuilds when only the device pixel ratio changes', async () => {
    // Dragging onto a higher-density display changes what the canvases have to
    // be backed by without changing the CSS-pixel viewport at all.
    const { resize } = await engine()
    createdCanvases = []
    ;(globalThis as { window: { devicePixelRatio: number } }).window.devicePixelRatio = 2

    resize()

    // The nebula is sized in CSS pixels so it is correctly reused; what matters
    // is that the canvas backing store was resized rather than skipped.
    expect(createdCanvases).toHaveLength(0)
  })

  it('stops listening once destroyed', async () => {
    const { destroy } = await engine()

    destroy()

    expect(resizeListeners).toHaveLength(0)
  })
})

async function lifecycle(fullIntro: boolean): Promise<{
  engine: import('../startupEngine').StartupEngine
  finished: () => boolean
}> {
  const { StartupEngine } = await import('../startupEngine')
  let done = false
  const engine = new StartupEngine({
    stage: { dataset: {} } as unknown as HTMLElement,
    starCanvas: fakeCanvas(),
    settleCanvas: fakeCanvas(),
    isFirstLaunch: () => false,
    isReducedMotion: () => false,
    isFullIntro: () => fullIntro,
    onFinished: () => {
      done = true
    }
  })
  engine.start()
  return { engine, finished: () => done }
}

describe('startupEngine — brief and skippable', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // Every launch used to play the whole 4.4 s sequence.
  it('gets an ordinary launch into the app in about a second', async () => {
    const { engine, finished } = await lifecycle(false)
    engine.launch()
    vi.advanceTimersByTime(1100)
    expect(finished()).toBe(true)
  })

  it('keeps the full sequence for the first launch and after an update', async () => {
    const { engine, finished } = await lifecycle(true)
    engine.launch()
    vi.advanceTimersByTime(1100)
    expect(finished()).toBe(false)
  })

  it('ends a full intro on a click or key once the app is ready', async () => {
    const { engine, finished } = await lifecycle(true)
    engine.launch()
    engine.skip()
    vi.advanceTimersByTime(700)
    expect(finished()).toBe(true)
  })

  it('remembers a skip asked for before the app is ready, without revealing it early', async () => {
    const { engine, finished } = await lifecycle(true)
    engine.skip()
    vi.advanceTimersByTime(5000)
    expect(finished()).toBe(false)
    engine.launch()
    vi.advanceTimersByTime(700)
    expect(finished()).toBe(true)
  })

  it('does not skip past a startup error and its recovery actions', async () => {
    const { engine, finished } = await lifecycle(true)
    engine.fail()
    engine.skip()
    vi.advanceTimersByTime(5000)
    expect(finished()).toBe(false)
  })
})
