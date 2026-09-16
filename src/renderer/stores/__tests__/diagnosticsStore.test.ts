import { beforeEach, describe, expect, it } from 'vitest'
import type { DiagnosticEntry } from '@shared/settings.types'
import {
  configureDiagnostics,
  forgetEntriesFromOtherVersions,
  useDiagnosticsStore
} from '../diagnosticsStore'

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

  it('captures extra detail on non-errors only when verbose logging is enabled', () => {
    useDiagnosticsStore.getState().add({ ...makeEntry('quiet', 'warning'), detail: 'debug detail' })
    expect(useDiagnosticsStore.getState().entries[0].detail).toBeUndefined()

    configureDiagnostics({ maxEntries: 250, clearOnRestart: false, verbose: true })
    useDiagnosticsStore
      .getState()
      .add({ ...makeEntry('verbose', 'warning'), detail: 'debug detail' })
    expect(useDiagnosticsStore.getState().entries[0].detail).toBe('debug detail')
  })

  it('always keeps an error’s detail — it is the only explanation the user gets', () => {
    configureDiagnostics({ maxEntries: 250, clearOnRestart: false, verbose: false })

    useDiagnosticsStore
      .getState()
      .add({ ...makeEntry('load failed', 'error'), detail: 'needs more VRAM than is available' })

    expect(useDiagnosticsStore.getState().entries[0].detail).toBe(
      'needs more VRAM than is available'
    )
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

  it('takes the newer copy of an entry it already has, so a resolution lands', () => {
    const entry = makeMainEntry('model failed to load', 2000)
    useDiagnosticsStore.getState().ingest([entry])

    // The same entry, sent again because the model loaded on the second go.
    useDiagnosticsStore.getState().ingest([{ ...entry, resolvedAt: 9000 }])

    const [only] = useDiagnosticsStore.getState().entries
    expect(useDiagnosticsStore.getState().entries).toHaveLength(1)
    expect(only.resolvedAt).toBe(9000)
  })

  it('keeps a resolved entry out of the export as still-standing', () => {
    useDiagnosticsStore
      .getState()
      .ingest([{ ...makeMainEntry('could not reach the mailbox', 2000), resolvedAt: 9000 }])

    expect(useDiagnosticsStore.getState().exportText()).toContain('Resolved:')
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

/**
 * Diagnostics live in this window's storage, so they outlive the update that fixed
 * them. Measured on a real machine: "7 unresolved errors" beside a log with none since
 * two versions earlier.
 */
describe('entries from an older version', () => {
  it('lets go of them, and keeps what this version raised', () => {
    useDiagnosticsStore.getState().ingest([
      { ...makeEntry('from 0.9.11'), id: 'old', timestamp: Date.now(), appVersion: '0.9.11' },
      { ...makeEntry('from before versions were recorded'), id: 'ancient', timestamp: Date.now() },
      { ...makeEntry('from this one'), id: 'current', timestamp: Date.now(), appVersion: '0.9.19' }
    ])

    forgetEntriesFromOtherVersions('0.9.19')

    expect(useDiagnosticsStore.getState().entries.map((entry) => entry.id)).toEqual(['current'])
  })

  it('stamps what it records afterwards, so the next update can do the same', () => {
    forgetEntriesFromOtherVersions('0.9.19')

    useDiagnosticsStore.getState().add(makeEntry('something failed', 'error'))

    expect(useDiagnosticsStore.getState().entries[0].appVersion).toBe('0.9.19')
  })
})
