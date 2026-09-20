import type { AnodexApi } from '@shared/ipc'
import { anodex } from '../../lib/anodex'

/**
 * Playing a reply out loud, from the window's point of view.
 *
 * All of it lives here rather than in the button so that two things stay true.
 * One reply speaks at a time — pressing play on a second stops the first, which
 * is what every player does and what the main process assumes anyway. And the
 * audio a reply became is kept, so pausing and playing again, or listening
 * twice, costs nothing: generating is slow, and paying that twice for the same
 * words would feel broken.
 */

/** Which reply holds the speaker, and what it is doing. */
export interface ReadAloudState {
  /** The message this state belongs to. */
  token: string
  phase: 'preparing' | 'playing' | 'paused'
  /** 1-based sentence being generated, while preparing. */
  sentence: number
  total: number
}

type Listener = () => void

let state: ReadAloudState | null = null
const listeners = new Set<Listener>()

function publish(next: ReadAloudState | null): void {
  state = next
  for (const listener of listeners) listener()
}

export function subscribe(listener: Listener): () => void {
  attachProgress()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function readAloudState(): ReadAloudState | null {
  return state
}

/**
 * The voice half of the bridge, if this window has one.
 *
 * Optional rather than assumed, and that is the removability promise made real
 * in the one place it can actually be tested: a window whose preload predates
 * voice, or a test that stubs the bridge with only the parts it cares about,
 * gets a button that renders nothing instead of a chat that throws. Voice
 * failing must never be the chat failing.
 */
function bridge(): AnodexApi['voice'] | null {
  return (anodex as Partial<AnodexApi>).voice ?? null
}

/**
 * Whether this build can speak at all.
 *
 * Asked once for the window, not once per reply: the answer cannot change while
 * the window is open, and a chat with two hundred messages in it should not send
 * two hundred identical questions across the bridge to be told the same thing.
 */
let readiness: Promise<boolean> | null = null
export function voiceReady(): Promise<boolean> {
  readiness ??= (bridge()?.available() ?? Promise.resolve(null))
    .then((report) => report?.ready ?? false)
    .catch(() => false)
  return readiness
}

/**
 * The last few replies that have been read, as finished audio.
 *
 * Keyed by message and checked against the text it was made from, because a
 * message can be edited or regenerated under the same id and playing the old
 * audio for new words is worse than the wait.
 */
const spoken = new Map<string, { text: string; wav: ArrayBuffer }>()
const KEEP = 8

function remember(token: string, text: string, wav: ArrayBuffer): void {
  spoken.delete(token)
  spoken.set(token, { text, wav })
  while (spoken.size > KEEP) {
    const oldest = spoken.keys().next().value
    if (oldest === undefined) break
    spoken.delete(oldest)
  }
}

let audio: HTMLAudioElement | null = null
/** The words the loaded audio was made from, so a reply that changed under the
 *  same id is not resumed as if nothing had happened. */
let loadedText: string | null = null
let objectUrl: string | null = null
/** Bumped by every start and stop, so a slow generation that has been abandoned
 *  cannot come back and start playing over whatever is speaking now. */
let generation = 0

function teardown(): void {
  if (audio) {
    audio.pause()
    audio.src = ''
    audio = null
  }
  loadedText = null
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl)
    objectUrl = null
  }
}

/** Stops whatever is speaking and forgets it, without touching the cache. */
export function stopReadAloud(): void {
  generation += 1
  teardown()
  void bridge()?.stop()
  publish(null)
}

function play(token: string, text: string, wav: ArrayBuffer): void {
  teardown()
  loadedText = text
  objectUrl = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }))
  const element = new Audio(objectUrl)
  audio = element
  const mine = generation
  element.onended = () => {
    if (generation === mine) {
      teardown()
      publish(null)
    }
  }
  element.onerror = () => {
    if (generation === mine) {
      teardown()
      publish(null)
    }
  }
  publish({ token, phase: 'playing', sentence: 0, total: 0 })
  void element.play().catch(() => {
    if (generation === mine) {
      teardown()
      publish(null)
    }
  })
}

/**
 * The whole of what the button does: play, pause, resume, or cancel, depending
 * on where this reply already is.
 */
export function toggleReadAloud(token: string, text: string): void {
  const current = state

  // Same reply, same words: this press is about the audio already loaded.
  if (current?.token === token && (current.phase === 'preparing' || loadedText === text)) {
    if (current.phase === 'playing' && audio) {
      audio.pause()
      publish({ ...current, phase: 'paused' })
      return
    }
    if (current.phase === 'paused' && audio) {
      const mine = generation
      publish({ ...current, phase: 'playing' })
      void audio.play().catch(() => {
        if (generation === mine) {
          teardown()
          publish(null)
        }
      })
      return
    }
    // Preparing: the press means "never mind".
    stopReadAloud()
    return
  }

  // A different reply had it, or nothing did.
  generation += 1
  teardown()
  const mine = generation

  const cached = spoken.get(token)
  if (cached && cached.text === text) {
    void bridge()?.stop()
    play(token, text, cached.wav)
    return
  }

  const voice = bridge()
  if (!voice) return

  publish({ token, phase: 'preparing', sentence: 0, total: 0 })
  void voice
    .speak(text)
    .then((wav) => {
      if (generation !== mine) return
      if (!wav) {
        publish(null)
        return
      }
      remember(token, text, wav)
      play(token, text, wav)
    })
    .catch(() => {
      if (generation === mine) publish(null)
    })
}

/**
 * Progress from the main process, which arrives as sentences are finished.
 *
 * Attached when something first listens rather than when this module loads, for
 * the same reason readiness is asked once: it is one listener for a window, not
 * one per reply — and a module that reaches across the bridge merely by being
 * imported is a module that cannot be imported anywhere else.
 */
let progressAttached = false
function attachProgress(): void {
  if (progressAttached) return
  progressAttached = true
  bridge()?.onProgress((progress) => {
    if (state?.phase !== 'preparing') return
    publish({ ...state, sentence: progress.index, total: progress.total })
  })
}
