/**
 * Wiring test: does `init()` actually connect both capture paths (the logger
 * sink and the IPC failure observer) to the log file, the ring buffer, and the
 * broadcast? The pieces are covered by `diagnosticsFormat`/`logFile` tests —
 * what this covers is that they are joined up, which is the part that silently
 * fails to hold.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// One directory for the whole suite: `init()` is idempotent by design, so it
// opens the log file exactly once and a per-test directory would orphan it.
const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anodex-reporter-'))

vi.mock('electron', () => ({
  app: { getPath: () => logsDir, getVersion: () => '9.9.9' }
}))

const broadcastToWindows = vi.fn()
vi.mock('../../broadcast', () => ({
  broadcastToWindows: (...args: unknown[]): void => {
    broadcastToWindows(...args)
  }
}))

const { diagnosticsReporter } = await import('../DiagnosticsReporter')
const { createLogger } = await import('../../utils/logger')
const { err, ok } = await import('@shared/result')

const readLog = (): string => fs.readFileSync(path.join(logsDir, 'anodex.log'), 'utf8')

// The one call that wires both sinks; every later call is a no-op.
diagnosticsReporter.init()

beforeEach(() => {
  broadcastToWindows.mockClear()
})

afterAll(() => {
  fs.rmSync(logsDir, { recursive: true, force: true })
})

describe('DiagnosticsReporter wiring', () => {
  it('writes a session banner naming the version and runtime', () => {
    expect(readLog()).toContain('Anodex 9.9.9 — session started')
    expect(readLog()).toContain(`${process.platform}/${process.arch}`)
  })

  it('captures a logger error as an entry with its stack and a suggested fix', () => {
    const error = new Error('ggml_backend_cuda: out of memory')
    error.stack = 'Error: ggml_backend_cuda: out of memory\n    at load (llama.js:1)'

    createLogger('llama').error('Failed to load model:', error)

    const [entry] = diagnosticsReporter.list()
    expect(entry.severity).toBe('error')
    expect(entry.category).toBe('model')
    expect(entry.scope).toBe('llama')
    expect(entry.source).toBe('main')
    expect(entry.message).toBe('Failed to load model')
    expect(entry.detail).toContain('at load (llama.js:1)')
    expect(entry.suggestedFix).toContain('GPU layers')
    expect(readLog()).toContain('[ERROR] [llama] Failed to load model')
  })

  it('pushes each entry to open windows as it is recorded', () => {
    createLogger('email:imap').warn('Mailbox sync failed')

    expect(broadcastToWindows).toHaveBeenCalledWith(
      'diagnostics:entry',
      expect.objectContaining({ message: 'Mailbox sync failed', category: 'integration' })
    )
  })

  it('keeps info and debug out of the app but still writes them to the file', () => {
    const before = diagnosticsReporter.list().length

    createLogger('settings').info('Initialised at', 'C:/settings.json')
    createLogger('updater').debug('Skipping update check')

    expect(diagnosticsReporter.list().length).toBe(before)
    expect(readLog()).toContain('[INFO] [settings] Initialised at')
    expect(readLog()).toContain('[DEBUG] [updater] Skipping update check')
  })

  it('records a failure returned to the renderer through err(), with its code', () => {
    err('models.load-failed', 'Failed to load the model.', 'Needs more VRAM than is available.')

    const [entry] = diagnosticsReporter.list()
    // A warning, not an error: many err() results are ordinary conditions.
    expect(entry.severity).toBe('warning')
    expect(entry.category).toBe('model')
    expect(entry.message).toBe('Failed to load the model.')
    expect(entry.detail).toContain('code: models.load-failed')
    expect(entry.detail).toContain('Needs more VRAM')
    expect(readLog()).toContain('Failed to load the model.')
  })

  it('leaves successful results alone', () => {
    const before = diagnosticsReporter.list().length

    ok('fine')

    expect(diagnosticsReporter.list().length).toBe(before)
  })

  it('marks a clean exit so a log without the marker means a hard kill', () => {
    diagnosticsReporter.shutdown()

    expect(readLog()).toContain('session ended')
  })
})
