import { beforeEach, describe, expect, it } from 'vitest'
import type { DiagnosticEntry } from '@shared/settings.types'
import { configureDiagnostics, useDiagnosticsStore } from '../diagnosticsStore'

beforeEach(() => {
  useDiagnosticsStore.getState().clear()
  configureDiagnostics({ maxEntries: 250, clearOnRestart: false, verbose: false })
})

describe('diagnosticsStore settings', () => {
  it('uses the configured retention limit', () => {
    configureDiagnostics({ maxEntries: 2, clearOnRestart: false, verbose: false })

    useDiagnosticsStore.getState().add(makeEntry('first'))
    useDiagnosticsStore.getState().add(makeEntry('second'))
    useDiagnosticsStore.getState().add(makeEntry('third'))

    expect(useDiagnosticsStore.getState().entries.map((entry) => entry.message)).toEqual([
      'third',
      'second'
    ])
  })

  it('captures extra detail only when verbose logging is enabled', () => {
    useDiagnosticsStore.getState().add({ ...makeEntry('quiet'), detail: 'debug detail' })
    expect(useDiagnosticsStore.getState().entries[0].detail).toBeUndefined()

    configureDiagnostics({ maxEntries: 250, clearOnRestart: false, verbose: true })
    useDiagnosticsStore.getState().add({ ...makeEntry('verbose'), detail: 'debug detail' })
    expect(useDiagnosticsStore.getState().entries[0].detail).toBe('debug detail')
  })

  it('removes info entries on startup while retaining warnings and errors', () => {
    configureDiagnostics({ maxEntries: 250, clearOnRestart: false, verbose: false })
    useDiagnosticsStore.getState().add(makeEntry('info', 'info'))
    useDiagnosticsStore.getState().add(makeEntry('warning', 'warning'))
    useDiagnosticsStore.getState().add(makeEntry('error', 'error'))

    configureDiagnostics({ maxEntries: 250, clearOnRestart: true, verbose: false }, true)

    expect(useDiagnosticsStore.getState().entries.map((entry) => entry.severity)).toEqual([
      'error',
      'warning'
    ])
  })
})

describe('diagnosticsStore.ingest', () => {
  it('merges main-process entries newest first', () => {
    useDiagnosticsStore.getState().add(makeEntry('from the window'))

    useDiagnosticsStore
      .getState()
      .ingest([makeMainEntry('older', 1000), makeMainEntry('newer', Date.now() + 5000)])

    expect(useDiagnosticsStore.getState().entries.map((entry) => entry.message)).toEqual([
      'newer',
      'from the window',
      'older'
    ])
  })

  it('ignores entries it already has, so a replayed backlog cannot duplicate', () => {
    const entry = makeMainEntry('model failed to load', 2000)

    useDiagnosticsStore.getState().ingest([entry])
    useDiagnosticsStore.getState().ingest([entry, makeMainEntry('second failure', 3000)])

    expect(useDiagnosticsStore.getState().entries.map((entry) => entry.message)).toEqual([
      'second failure',
      'model failed to load'
    ])
  })

  it('keeps the technical detail even with verbose logging off', () => {
    configureDiagnostics({ maxEntries: 250, clearOnRestart: false, verbose: false })

    useDiagnosticsStore
      .getState()
      .ingest([{ ...makeMainEntry('crashed', 4000), detail: 'Error: boom\n    at load()' }])

    expect(useDiagnosticsStore.getState().entries[0].detail).toBe('Error: boom\n    at load()')
  })

  it('honors the retention limit across both sources', () => {
    configureDiagnostics({ maxEntries: 2, clearOnRestart: false, verbose: false })
    useDiagnosticsStore.getState().add(makeEntry('in-app'))

    useDiagnosticsStore
      .getState()
      .ingest([makeMainEntry('one', Date.now() + 1000), makeMainEntry('two', Date.now() + 2000)])

    expect(useDiagnosticsStore.getState().entries.map((entry) => entry.message)).toEqual([
      'two',
      'one'
    ])
  })
})

function makeEntry(
  message: string,
  severity: 'error' | 'warning' | 'info' = 'error'
): Parameters<ReturnType<typeof useDiagnosticsStore.getState>['add']>[0] {
  return { severity, category: 'runtime', message }
}

function makeMainEntry(message: string, timestamp: number): DiagnosticEntry {
  return {
    id: `main-${message}`,
    timestamp,
    severity: 'error',
    category: 'model',
    message,
    source: 'main',
    scope: 'llama'
  }
}
