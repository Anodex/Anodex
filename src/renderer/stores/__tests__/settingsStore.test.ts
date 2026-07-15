import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultSettings } from '@shared/settings.defaults'
import type { AppSettings } from '@shared/settings.types'

const { updateMock } = vi.hoisted(() => ({ updateMock: vi.fn() }))

vi.mock('../../lib/anodex', () => ({
  anodex: {
    settings: {
      get: vi.fn(),
      update: updateMock
    }
  }
}))

vi.mock('../diagnosticsStore', () => ({ configureDiagnostics: vi.fn() }))

import { useSettingsStore } from '../settingsStore'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('settingsStore optimistic updates', () => {
  beforeEach(() => {
    updateMock.mockReset()
    useSettingsStore.setState({
      settings: createDefaultSettings('/models'),
      loaded: true
    })
  })

  it('keeps the newest selection when IPC responses finish out of order', async () => {
    const first = deferred<AppSettings>()
    const second = deferred<AppSettings>()
    updateMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

    const firstUpdate = useSettingsStore.getState().update({
      appearance: { soundTheme: 'crisp' }
    })
    const secondUpdate = useSettingsStore.getState().update({
      appearance: { soundTheme: 'glass' }
    })

    expect(useSettingsStore.getState().settings?.appearance.soundTheme).toBe('glass')

    second.resolve({
      ...createDefaultSettings('/models'),
      appearance: {
        ...createDefaultSettings('/models').appearance,
        soundTheme: 'glass'
      }
    })
    await secondUpdate

    first.resolve({
      ...createDefaultSettings('/models'),
      appearance: {
        ...createDefaultSettings('/models').appearance,
        soundTheme: 'crisp'
      }
    })
    await firstUpdate

    expect(useSettingsStore.getState().settings?.appearance.soundTheme).toBe('glass')
  })
})
