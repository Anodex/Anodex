import { beforeEach, describe, expect, it } from 'vitest'
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

function makeEntry(
  message: string,
  severity: 'error' | 'warning' | 'info' = 'error'
): Parameters<ReturnType<typeof useDiagnosticsStore.getState>['add']>[0] {
  return { severity, category: 'runtime', message }
}
