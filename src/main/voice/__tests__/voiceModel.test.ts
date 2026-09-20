import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Fetching 2.3 GB, and the parts of that which are not the network.
 *
 * The download itself is two HTTP bodies and belongs to `modelDownloader`, which
 * is tested where it lives. What is new here is the arithmetic around them, and
 * every rule below is one somebody would only notice by watching a progress bar
 * for ten minutes: a bar that finishes and starts again, a resumed download that
 * re-fetches two gigabytes it already has, or a second click that races the
 * first.
 */

const files = new Set<string>()
const downloadFile = vi.fn(
  async (
    _url: string,
    finalPath: string,
    signal: AbortSignal,
    onProgress: (received: number, total: number | null) => void
  ) => {
    if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    onProgress(10, null)
    await Promise.resolve()
    files.add(finalPath)
  }
)

vi.mock('../../llama/modelDownloader', () => ({
  downloadFile: (...args: unknown[]) => downloadFile(...(args as Parameters<typeof downloadFile>))
}))

vi.mock('../Speaker', () => ({
  voiceModelPaths: () => ({ model: '/voice/model.gguf', projector: '/voice/mmproj.gguf' })
}))

vi.mock('node:fs', () => ({
  existsSync: (path: string) => files.has(path),
  statSync: () => ({ size: 1_000 })
}))

vi.mock('node:fs/promises', () => ({
  mkdir: () => Promise.resolve(),
  rm: (path: string) => {
    files.delete(path)
    return Promise.resolve()
  }
}))

const voiceModel = await import('../voiceModel')

beforeEach(() => {
  files.clear()
  downloadFile.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('fetching the voice', () => {
  it('knows what it costs before it starts', () => {
    // Said out loud on the button, so it cannot be a guess: these are the two
    // sizes from the repository's own listing, and they are the weights every
    // measurement in the handoff was taken with.
    expect(voiceModel.VOICE_MODEL_BYTES).toBe(1_847_874_400 + 446_422_912)
  })

  it('fetches both halves', async () => {
    await voiceModel.downloadVoiceModel(() => {})
    expect(downloadFile).toHaveBeenCalledTimes(2)
    const urls = downloadFile.mock.calls.map((call) => call[0])
    expect(urls[0]).toContain('Qwen3-TTS-12Hz-1.7B-Base-Q8_0.gguf')
    expect(urls[1]).toContain('mmproj-Qwen3-TTS-12Hz-1.7B-Base-Q8_0.gguf')
  })

  it('reports one bar across the pair, never restarting it', async () => {
    // Two files reported separately would show the bar reach the end and go
    // back to nothing, which reads as a fault rather than as progress.
    const seen: number[] = []
    await voiceModel.downloadVoiceModel((progress) => seen.push(progress.receivedBytes))

    expect(seen.length).toBeGreaterThan(1)
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1])
    }
    expect(seen.every((bytes) => bytes <= voiceModel.VOICE_MODEL_BYTES)).toBe(true)
  })

  it('does not fetch a half it already has', async () => {
    // The interrupted case: the big file landed, the app closed, and pressing
    // download again should cost the 446 MB that is missing, not 2.3 GB.
    files.add('/voice/model.gguf')
    await voiceModel.downloadVoiceModel(() => {})
    expect(downloadFile).toHaveBeenCalledTimes(1)
    expect(downloadFile.mock.calls[0][0]).toContain('mmproj')
  })

  it('refuses a second download rather than racing the first', async () => {
    let release = (): void => {}
    downloadFile.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const first = voiceModel.downloadVoiceModel(() => {})
    expect(voiceModel.voiceModelDownloading()).toBe(true)
    await expect(voiceModel.downloadVoiceModel(() => {})).rejects.toThrow(/already downloading/)

    release()
    await first
    expect(voiceModel.voiceModelDownloading()).toBe(false)
  })

  it('stops downloading when told to', async () => {
    let started = (): void => {}
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve
    })
    downloadFile.mockImplementationOnce((_url, _path, signal) => {
      started()
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        )
      })
    })

    const running = voiceModel.downloadVoiceModel(() => {})
    await startedPromise
    voiceModel.cancelVoiceModelDownload()

    await expect(running).rejects.toThrow()
    // The flag has to clear, or the button never comes back.
    expect(voiceModel.voiceModelDownloading()).toBe(false)
  })

  it('removes both files and nothing else', async () => {
    files.add('/voice/model.gguf')
    files.add('/voice/mmproj.gguf')
    files.add('/voice/arc/reference.wav')

    await voiceModel.removeVoiceModel()
    expect(files.has('/voice/model.gguf')).toBe(false)
    expect(files.has('/voice/mmproj.gguf')).toBe(false)
    // Arc's voice is the product's identity and ships with the app. Reclaiming
    // space must never take it.
    expect(files.has('/voice/arc/reference.wav')).toBe(true)
  })

  it('counts what is already on disk', () => {
    expect(voiceModel.voiceModelBytesPresent()).toBe(0)
    files.add('/voice/model.gguf')
    expect(voiceModel.voiceModelBytesPresent()).toBe(1_000)
  })
})
