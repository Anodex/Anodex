import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import {
  collectConsoleMessages,
  formatPageDiagnostics,
  hasFailureEvidence,
  type PageDiagnostics
} from '../pageDiagnostics'

function diagnostics(overrides: Partial<PageDiagnostics> = {}): PageDiagnostics {
  return {
    errors: [],
    rejections: [],
    resourceFailures: [],
    canvases: [],
    webgl: { supported: true },
    readyState: 'complete',
    console: [],
    blockedRequests: [],
    ...overrides
  }
}

/** Minimal `WebContents` stub exposing only the event surface under test. */
function fakeWebContents(): {
  webContents: WebContents
  emit: (...args: unknown[]) => void
} {
  let handler: ((...args: unknown[]) => void) | null = null
  const webContents = {
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'console-message') handler = listener
    })
  } as unknown as WebContents
  return { webContents, emit: (...args) => handler?.(...args) }
}

describe('formatPageDiagnostics', () => {
  it('leads with uncaught errors, which name the fault directly', () => {
    const text = formatPageDiagnostics(
      diagnostics({
        errors: [{ message: 'THREE is not defined', source: 'sandbox.js', line: 12, column: 3 }]
      })
    )

    expect(text).toContain('Uncaught errors:')
    expect(text).toContain('THREE is not defined')
    expect(text).toContain('sandbox.js:12:3')
  })

  it('reports a blocked request as an inspection limit, not a page defect', () => {
    const text = formatPageDiagnostics(
      diagnostics({
        blockedRequests: [{ url: 'https://cdn.example.test/three.js', reason: 'not-declared' }]
      })
    )

    expect(text).toContain('https://cdn.example.test/three.js')
    expect(text).toContain('inspection limit, not a defect in the page')
  })

  it('flags a zero-size canvas explicitly', () => {
    const text = formatPageDiagnostics(
      diagnostics({
        canvases: [
          {
            id: 'sandboxCanvas',
            cssWidth: 0,
            cssHeight: 0,
            attrWidth: 300,
            attrHeight: 150,
            contextType: 'webgl2'
          }
        ]
      })
    )

    expect(text).toContain('ZERO LAYOUT SIZE')
  })

  it('warns when a drawing page has no WebGL available', () => {
    const text = formatPageDiagnostics(
      diagnostics({
        webgl: { supported: false },
        canvases: [
          {
            id: 'c',
            cssWidth: 800,
            cssHeight: 600,
            attrWidth: 800,
            attrHeight: 600,
            contextType: 'none'
          }
        ]
      })
    )

    expect(text).toContain('NOT AVAILABLE')
  })

  it('stays silent about WebGL on a page with no canvas', () => {
    const text = formatPageDiagnostics(diagnostics({ webgl: { supported: false } }))

    expect(text).not.toContain('WebGL')
  })

  it('states a clean result affirmatively, because "no errors" rules hypotheses out', () => {
    const text = formatPageDiagnostics(diagnostics())

    expect(text).toContain('no uncaught errors')
    expect(text).toContain('A runtime exception is ruled out')
  })
})

describe('hasFailureEvidence', () => {
  it('is false for a clean page', () => {
    expect(hasFailureEvidence(diagnostics())).toBe(false)
  })

  it('is true when a request was blocked', () => {
    expect(
      hasFailureEvidence(
        diagnostics({ blockedRequests: [{ url: 'https://x.test/a.js', reason: 'not-declared' }] })
      )
    ).toBe(true)
  })

  it('is true for a console error', () => {
    expect(hasFailureEvidence(diagnostics({ console: [{ level: 'error', text: 'boom' }] }))).toBe(
      true
    )
  })
})

describe('collectConsoleMessages', () => {
  it('captures the current single-object event shape', () => {
    const { webContents, emit } = fakeWebContents()
    const entries = collectConsoleMessages(webContents)

    emit({ level: 'error', message: 'Failed to load module script' })

    expect(entries).toEqual([{ level: 'error', text: 'Failed to load module script' }])
  })

  /**
   * Electron changed this event's signature. Handling both shapes keeps the
   * channel working across upgrades — a silently empty diagnostics channel is
   * the exact failure mode this module exists to remove.
   */
  it('captures the legacy positional event shape', () => {
    const { webContents, emit } = fakeWebContents()
    const entries = collectConsoleMessages(webContents)

    emit({}, 3, 'CORS policy blocked the request', 42, 'page.html')

    expect(entries).toEqual([{ level: 'error', text: 'CORS policy blocked the request' }])
  })

  it('ignores info-level noise', () => {
    const { webContents, emit } = fakeWebContents()
    const entries = collectConsoleMessages(webContents)

    emit({ level: 'info', message: 'Universe Sandbox: Starting...' })

    expect(entries).toEqual([])
  })
})
