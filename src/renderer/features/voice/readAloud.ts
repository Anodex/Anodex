import type { AnodexApi } from '@shared/ipc'
import { anodex } from '../../lib/anodex'
import { notifyError } from '../../stores/uiStore'

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

/**
 * Throw away the cached answer, because it just stopped being true.
 *
 * The cache is right about a window's lifetime with one exception: Settings is
 * where somebody downloads the voice or removes it, and either makes the cached
 * answer wrong for every reply already on screen.
 */
export function forgetVoiceReadiness(): void {
  readiness = null
}
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

/**
 * Playing through Web Audio rather than an `<audio>` element.
 *
 * The element was the obvious choice and it made no sound at all. Forty-two
 * seconds of real speech reached the window — measured afterwards at 51% peak,
 * so not silence — and the element refused to load it:
 *
 *     MEDIA_ELEMENT_ERROR: Media load rejected by URL safety check
 *
 * The renderer's CSP in `index.html` sets no `media-src`, so it falls through to
 * `default-src 'self'`, and a `blob:` URL is not `'self'`. Every audio element
 * fed a generated blob is blocked, always, on every machine. Reproduced against
 * that exact policy before this was rewritten, because the first theory —
 * expired user activation — was wrong and would have produced a confident fix
 * for the wrong thing.
 *
 * Web Audio never fetches a URL: `decodeAudioData` takes the bytes and the
 * source node connects straight to the destination, so no `media-src` applies.
 * It is also what `lib/sound.ts` already uses for every notification in this
 * app, which makes it the path known to work here rather than a second guess.
 *
 * Widening the CSP would have been the other fix and is the worse one: it buys
 * a mechanism this does not need, in exchange for a hole in a policy that is
 * doing its job. Note that `previewContentSecurityPolicy.ts` has carried
 * `media-src data: blob:` and a comment about this exact silent failure the
 * whole time — the lesson was written down one file away and not applied here.
 *
 * The context is created and resumed on the click. That is not about the CSP;
 * it is because generation takes about thirty seconds and a context that starts
 * suspended should be woken while a gesture is still in hand.
 *
 * Its own context, not the one notifications use: pausing here must not silence
 * anything else, and a directory built to be deleted should not own a handle
 * that something outside it depends on.
 */
let context: AudioContext | null = null
let source: AudioBufferSourceNode | null = null
let buffer: AudioBuffer | null = null
/** Where in the buffer the next `start()` should begin, in seconds. */
let offsetSeconds = 0
/** `context.currentTime` when the current source began, less the offset it began at. */
let baseTime = 0
/** The words the loaded audio was made from, so a reply that changed under the
 *  same id is not resumed as if nothing had happened. */
let loadedText: string | null = null
/** Bumped by every start and stop, so a slow generation that has been abandoned
 *  cannot come back and start playing over whatever is speaking now. */
let generation = 0

/**
 * Get the context ready to make sound.
 *
 * Called synchronously from the click, and that timing is the entire point:
 * `resume()` is the call that needs the activation, and a context that is
 * running stays running.
 */
function wakeAudio(): AudioContext | null {
  if (typeof window === 'undefined' || !window.AudioContext) return null
  context ??= new AudioContext()
  if (context.state === 'suspended') void context.resume().catch(() => undefined)
  return context
}

/** Stop the current source without letting its `onended` report the stop. */
function silence(): void {
  if (source) {
    source.onended = null
    try {
      source.stop()
    } catch {
      // Already stopped, or never started. Either way there is nothing to stop.
    }
    source.disconnect()
    source = null
  }
}

function teardown(): void {
  silence()
  buffer = null
  loadedText = null
  offsetSeconds = 0
}

/** Stops whatever is speaking and forgets it, without touching the cache. */
export function stopReadAloud(): void {
  generation += 1
  teardown()
  void bridge()?.stop()
  publish(null)
}

/**
 * What went wrong, said out loud.
 *
 * Every failure here used to end the same way: the button went quietly back to
 * "Listen" and nothing anywhere said why, which is how 42 seconds of generated
 * speech became "there is no sound at all" with no evidence attached. A refusal
 * that leaves no trace is worse than the refusal.
 */
function failed(reason: string): void {
  notifyError('Arc could not be played', reason)
  teardown()
  publish(null)
}

/** Start the loaded buffer at `offsetSeconds`, on a context already awake. */
function startSource(token: string): void {
  const ctx = context
  if (!ctx || !buffer) return
  silence()

  const node = ctx.createBufferSource()
  node.buffer = buffer
  node.connect(ctx.destination)
  source = node
  baseTime = ctx.currentTime - offsetSeconds

  const mine = generation
  node.onended = () => {
    if (generation === mine) {
      teardown()
      publish(null)
    }
  }

  node.start(0, offsetSeconds)
  publish({ token, phase: 'playing', sentence: 0, total: 0 })
}

/** Decode a finished wav and begin playing it. */
async function play(token: string, text: string, wav: ArrayBuffer): Promise<void> {
  const ctx = wakeAudio()
  if (!ctx) {
    failed('This window has no audio output.')
    return
  }

  const mine = generation
  // A copy, because decoding detaches the buffer it is handed, and the wav is
  // kept so that listening a second time does not generate it again.
  const bytes = wav instanceof Uint8Array ? wav : new Uint8Array(wav)
  let decoded: AudioBuffer
  try {
    decoded = await ctx.decodeAudioData(bytes.slice().buffer)
  } catch {
    failed('The audio could not be decoded.')
    return
  }
  if (generation !== mine) return

  buffer = decoded
  loadedText = text
  offsetSeconds = 0
  startSource(token)
}

/**
 * The whole of what the button does: play, pause, resume, or cancel, depending
 * on where this reply already is.
 */
export function toggleReadAloud(token: string, text: string): void {
  // First, and synchronously: this is the only moment the click's activation is
  // still live, and the audio it asks for will not be ready for half a minute.
  wakeAudio()

  const current = state

  // Same reply, same words: this press is about the audio already loaded.
  if (current?.token === token && (current.phase === 'preparing' || loadedText === text)) {
    if (current.phase === 'playing' && buffer && context) {
      // A source node cannot be paused, only stopped, so pausing is remembering
      // where it reached and building a new one from there on the way back.
      offsetSeconds = Math.min(context.currentTime - baseTime, buffer.duration)
      silence()
      publish({ ...current, phase: 'paused' })
      return
    }
    if (current.phase === 'paused' && buffer) {
      startSource(token)
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
    void play(token, text, cached.wav)
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
      void play(token, text, wav)
    })
    .catch((error: unknown) => {
      if (generation !== mine) return
      failed(error instanceof Error ? error.message : 'Generating the speech failed.')
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
