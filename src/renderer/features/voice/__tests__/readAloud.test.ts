// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * What the listen button does, without any audio.
 *
 * Every rule here is one a person would notice immediately and a type checker
 * never would: two replies speaking over each other, a second press paying the
 * two-second generation again, or a cancelled reply arriving late and starting
 * to talk over the one that replaced it. The audio itself is the model's problem
 * and is measured elsewhere; this is the bookkeeping around it.
 */

const speak = vi.fn<(text: string) => Promise<ArrayBuffer | null>>()
const stop = vi.fn(() => Promise.resolve(true))
const available = vi.fn(() => Promise.resolve({ enabled: true, modelReady: true, ready: true }))
type Progress = { id: string; index: number; total: number }
let progressListener: ((progress: Progress) => void) | null = null

/** Flipped by the one test that asks what happens without a voice bridge. */
let hasVoice = true

vi.mock('../../../lib/anodex', () => ({
  anodex: {
    get voice() {
      return hasVoice ? voiceBridge : undefined
    }
  }
}))

const voiceBridge = {
  available: () => available(),
  speak: (text: string) => speak(text),
  stop: () => stop(),
  onProgress: (listener: (progress: Progress) => void) => {
    progressListener = listener
    return () => {
      progressListener = null
    }
  }
}

/** Enough of an audio element to tell playing from paused. */
class FakeAudio {
  static live: FakeAudio[] = []
  playing = false
  src: string
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(src: string) {
    this.src = src
    FakeAudio.live.push(this)
  }
  play(): Promise<void> {
    this.playing = true
    return Promise.resolve()
  }
  pause(): void {
    this.playing = false
  }
}

const wav = (byte: number): ArrayBuffer => new Uint8Array([byte]).buffer

/** Lets the promise chain inside a press settle, the way a click then a tick does. */
const settle = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

let readAloud: typeof import('../readAloud')

beforeEach(async () => {
  vi.resetModules()
  FakeAudio.live = []
  speak.mockReset()
  stop.mockClear()
  available.mockClear()
  progressListener = null
  hasVoice = true
  vi.stubGlobal('Audio', FakeAudio)
  // Patched onto the real URL rather than replacing it: jsdom uses URL itself
  // for every document it loads, and swapping the whole global breaks it.
  URL.createObjectURL = (blob: Blob) => `blob:${blob.size}`
  URL.revokeObjectURL = () => {}
  readAloud = await import('../readAloud')
  readAloud.subscribe(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('reading a reply aloud', () => {
  it('says nothing until asked', () => {
    expect(readAloud.readAloudState()).toBeNull()
  })

  it('shows the wait before it shows the words', async () => {
    // The gap between the press and the first sound is seconds, so it has to be
    // visible or the button looks dead.
    let finish: (value: ArrayBuffer) => void = () => {}
    speak.mockReturnValue(
      new Promise<ArrayBuffer>((resolve) => {
        finish = resolve
      })
    )
    readAloud.toggleReadAloud('m1', 'Good morning.')
    expect(readAloud.readAloudState()).toMatchObject({ token: 'm1', phase: 'preparing' })

    progressListener?.({ id: '1', index: 2, total: 5 })
    expect(readAloud.readAloudState()).toMatchObject({ sentence: 2, total: 5 })

    finish(wav(1))
    await settle()
    expect(readAloud.readAloudState()).toMatchObject({ token: 'm1', phase: 'playing' })
    expect(FakeAudio.live.at(-1)?.playing).toBe(true)
  })

  it('pauses and resumes the same audio rather than making it again', async () => {
    speak.mockResolvedValue(wav(1))
    readAloud.toggleReadAloud('m1', 'Good morning.')
    await settle()

    readAloud.toggleReadAloud('m1', 'Good morning.')
    expect(readAloud.readAloudState()).toMatchObject({ phase: 'paused' })
    expect(FakeAudio.live.at(-1)?.playing).toBe(false)

    readAloud.toggleReadAloud('m1', 'Good morning.')
    expect(readAloud.readAloudState()).toMatchObject({ phase: 'playing' })
    expect(FakeAudio.live).toHaveLength(1)
    expect(speak).toHaveBeenCalledTimes(1)
  })

  it('only speaks one reply at a time', async () => {
    speak.mockResolvedValue(wav(1))
    readAloud.toggleReadAloud('m1', 'First.')
    await settle()
    readAloud.toggleReadAloud('m2', 'Second.')
    await settle()

    expect(readAloud.readAloudState()).toMatchObject({ token: 'm2', phase: 'playing' })
    // The first one is not merely unlabelled — it is actually stopped.
    expect(FakeAudio.live[0].playing).toBe(false)
  })

  it('does not generate the same reply twice', async () => {
    speak.mockResolvedValue(wav(1))
    readAloud.toggleReadAloud('m1', 'Good morning.')
    await settle()
    readAloud.toggleReadAloud('m2', 'Something else.')
    await settle()
    readAloud.toggleReadAloud('m1', 'Good morning.')
    await settle()

    expect(speak).toHaveBeenCalledTimes(2)
    expect(readAloud.readAloudState()).toMatchObject({ token: 'm1', phase: 'playing' })
  })

  it('generates again when the reply itself changed', async () => {
    // Same message id, different words: regenerating, or an edit. Playing the
    // old audio here would be worse than the wait, because it would be wrong.
    speak.mockResolvedValue(wav(1))
    readAloud.toggleReadAloud('m1', 'Good morning.')
    await settle()
    readAloud.toggleReadAloud('m1', 'Good morning.')
    readAloud.toggleReadAloud('m1', 'Good evening.')
    await settle()

    expect(speak).toHaveBeenCalledTimes(2)
    expect(speak).toHaveBeenLastCalledWith('Good evening.')
  })

  it('stops while it is still getting ready', () => {
    speak.mockReturnValue(new Promise<ArrayBuffer>(() => {}))
    readAloud.toggleReadAloud('m1', 'Good morning.')
    readAloud.toggleReadAloud('m1', 'Good morning.')

    expect(readAloud.readAloudState()).toBeNull()
    expect(stop).toHaveBeenCalled()
  })

  it('never lets an abandoned reply start talking', async () => {
    // The failure this prevents, which is the one that actually happens: you
    // press play, wait, give up, press play on something else, and thirty
    // seconds later the first one starts underneath it.
    let finish: (value: ArrayBuffer) => void = () => {}
    speak.mockReturnValueOnce(
      new Promise<ArrayBuffer>((resolve) => {
        finish = resolve
      })
    )
    readAloud.toggleReadAloud('m1', 'Slow one.')

    speak.mockResolvedValue(wav(2))
    readAloud.toggleReadAloud('m2', 'Quick one.')
    await settle()

    finish(wav(1))
    await settle()
    expect(readAloud.readAloudState()).toMatchObject({ token: 'm2', phase: 'playing' })
    expect(FakeAudio.live).toHaveLength(1)
  })

  it('clears itself when the audio ends', async () => {
    speak.mockResolvedValue(wav(1))
    readAloud.toggleReadAloud('m1', 'Good morning.')
    await settle()
    FakeAudio.live[0].onended?.()
    expect(readAloud.readAloudState()).toBeNull()
  })

  it('gives up quietly when there was nothing to say', async () => {
    speak.mockResolvedValue(null)
    readAloud.toggleReadAloud('m1', '...')
    await settle()
    expect(readAloud.readAloudState()).toBeNull()
  })

  it('is simply absent when the window has no voice bridge at all', async () => {
    // The removability promise, tested rather than asserted: voice missing has
    // to mean a button that is not there, never a chat that throws.
    hasVoice = false
    expect(await readAloud.voiceReady()).toBe(false)
    expect(() => readAloud.toggleReadAloud('m1', 'Good morning.')).not.toThrow()
    expect(readAloud.readAloudState()).toBeNull()
    expect(speak).not.toHaveBeenCalled()
  })

  it('asks whether it can speak once, however many replies ask', async () => {
    await Promise.all([readAloud.voiceReady(), readAloud.voiceReady(), readAloud.voiceReady()])
    expect(available).toHaveBeenCalledTimes(1)
  })
})
