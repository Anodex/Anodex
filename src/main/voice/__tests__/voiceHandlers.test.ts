import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The switch that turns voice off, tested where it was ignored.
 *
 * `ANODEX_VOICE` is the promise that none of this exists unless it is asked for,
 * and the first version of these handlers broke that promise in the quietest
 * possible way: it reported `enabled` to the window and then decided on
 * `speechAvailable()` alone, which asks only whether the machinery is installed.
 * A machine holding the model got the button with the feature switched off, and
 * nothing anywhere said so.
 *
 * A rule written in one file and re-decided in another is the shape this
 * codebase keeps producing. So the rule is checked here rather than trusted.
 */

const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }
  },
  app: { isPackaged: false, getPath: () => '/userData' }
}))

const speechAvailable = vi.fn(() => true)
const speak = vi.fn(() => Promise.resolve([]))

vi.mock('../Speaker', () => ({
  speechAvailable: () => speechAvailable(),
  voiceModelReady: () => true,
  voiceModelPaths: () => ({ model: '/voice/model.gguf', projector: '/voice/mmproj.gguf' }),
  speak: (...args: unknown[]) => speak(...(args as [])),
  silencePcm: () => Buffer.alloc(0),
  wavHeader: () => Buffer.alloc(44)
}))

const { registerVoiceHandlers } = await import('../voice.handlers')
const { IpcChannel } = await import('../../../shared/ipc')

registerVoiceHandlers()

const available = (): { enabled: boolean; modelReady: boolean; ready: boolean } =>
  handlers.get(IpcChannel.Voice.available)?.() as never

const askToSpeak = (): Promise<unknown> =>
  handlers.get(IpcChannel.Voice.speak)?.(
    { sender: { isDestroyed: () => true, send: () => {} } },
    'Good morning.'
  ) as Promise<unknown>

beforeEach(() => {
  speak.mockClear()
  speechAvailable.mockReturnValue(true)
})

afterEach(() => {
  delete process.env.ANODEX_VOICE
})

describe('offering to read a reply aloud', () => {
  it('offers nothing while voice is switched off', () => {
    delete process.env.ANODEX_VOICE
    expect(available().ready).toBe(false)
  })

  it('refuses to speak while voice is switched off, however complete the install', async () => {
    // The failure this prevents is not a crash. It is a feature that is meant to
    // be off quietly turning itself on because the parts happen to be present.
    delete process.env.ANODEX_VOICE
    expect(await askToSpeak()).toBeNull()
    expect(speak).not.toHaveBeenCalled()
  })

  it('offers it once voice is switched on and the model is there', () => {
    process.env.ANODEX_VOICE = '1'
    expect(available()).toMatchObject({ enabled: true, modelReady: true, ready: true })
  })

  it('still says no when the model has not been fetched', async () => {
    // Switched on but incomplete, which is every machine until the model
    // downloads: the honest answer is not-ready, not a button that fails.
    process.env.ANODEX_VOICE = '1'
    speechAvailable.mockReturnValue(false)
    expect(available().ready).toBe(false)
    expect(await askToSpeak()).toBeNull()
  })

  it('tells a window which part is missing, not merely that it cannot', () => {
    delete process.env.ANODEX_VOICE
    const report = available()
    expect(report.enabled).toBe(false)
    expect(report.modelReady).toBe(true)
  })
})
