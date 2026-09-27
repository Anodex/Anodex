import { anodex } from '../../lib/anodex'
import { notifyError } from '../../stores/uiStore'
import { useSettingsStore } from '../../stores/settingsStore'

export interface ReadAloudState {
  token: string
  phase: 'preparing' | 'playing' | 'paused'
}

/** Keep spoken output aligned with visible prose, without reading Markdown syntax or code blocks. */
export function normalizeSpeechText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^[#>\s-]+/gm, '')
    .replace(/[*_~]/g, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\s+/g, ' ')
    .trim()
}

let state: ReadAloudState | null = null
const listeners = new Set<() => void>()
const readinessListeners = new Set<() => void>()
let context: AudioContext | null = null
let nextPlayTime = 0
let playbackGain: GainNode | null = null
let audioStarted = false
const sources = new Set<AudioBufferSourceNode>()
let requestCounter = 0
let activeRequest = ''
let pendingByte: number | null = null
let generationFinished = false
let finishTimer: ReturnType<typeof setTimeout> | undefined
let statusPromise: Promise<boolean> | null = null
let audioSubscription: (() => void) | null = null

function publish(next: ReadAloudState | null): void {
  state = next
  for (const listener of listeners) listener()
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function readAloudState(): ReadAloudState | null {
  return state
}

export function forgetSpeechReadiness(): void {
  statusPromise = null
  for (const listener of readinessListeners) listener()
}

export function subscribeReadiness(listener: () => void): () => void {
  readinessListeners.add(listener)
  return () => readinessListeners.delete(listener)
}

export function speechReady(): Promise<boolean> {
  statusPromise ??= anodex.speech.status().then(
    (status) => status.runtimeAvailable && status.modelInstalled,
    () => false
  )
  return statusPromise
}

function audioContext(): AudioContext | null {
  if (typeof window === 'undefined' || !window.AudioContext) return null
  if (!context || context.state === 'closed') {
    context = new AudioContext()
  }
  return context
}

function receiveAudio(chunk: { requestId: string; pcm: Uint8Array; sampleRate: number }): void {
  if (chunk.requestId !== activeRequest || !context) return
  if (!Number.isInteger(chunk.sampleRate) || chunk.sampleRate < 8000 || chunk.sampleRate > 96000) {
    fail('The voice engine returned an invalid sample rate.')
    return
  }
  const pcm = chunk.pcm instanceof Uint8Array ? chunk.pcm : new Uint8Array(chunk.pcm)
  if (state?.phase === 'preparing') publish({ ...state, phase: 'playing' })
  const count = Math.floor((pcm.length + (pendingByte === null ? 0 : 1)) / 2)
  if (count === 0) {
    if (pcm.length) pendingByte = pcm[0]
    return
  }
  const floats = new Float32Array(count)
  let outputIndex = 0
  let inputIndex = 0
  if (pendingByte !== null) {
    const sample = ((pendingByte | (pcm[0] << 8)) << 16) >> 16
    floats[outputIndex++] = sample < 0 ? sample / 32768 : sample / 32767
    pendingByte = null
    inputIndex = 1
  }
  for (; inputIndex + 1 < pcm.length; inputIndex += 2) {
    const sample = ((pcm[inputIndex] | (pcm[inputIndex + 1] << 8)) << 16) >> 16
    floats[outputIndex++] = sample < 0 ? sample / 32768 : sample / 32767
  }
  if (inputIndex < pcm.length) pendingByte = pcm[inputIndex]

  const buffer = context.createBuffer(1, floats.length, chunk.sampleRate)
  buffer.copyToChannel(floats, 0)
  const source = context.createBufferSource()
  source.buffer = buffer
  const speed = useSettingsStore.getState().settings?.speech.speed ?? 1
  source.playbackRate.value = speed
  const pocket = useSettingsStore.getState().settings?.speech.engine === 'pocket'
  if (pocket && !playbackGain) {
    playbackGain = context.createGain()
    playbackGain.connect(context.destination)
  }
  source.connect(playbackGain ?? context.destination)
  sources.add(source)
  source.onended = () => {
    sources.delete(source)
    finishIfReady()
  }
  // Prebuffer only the first Pocket chunk. Reapplying that lead to later chunks
  // inserts silence whenever the already scheduled audio drops below 100 ms.
  const lead = pocket ? (audioStarted ? 0.005 : 0.1) : 0.025
  nextPlayTime = Math.max(nextPlayTime, context.currentTime + lead)
  if (pocket && !audioStarted && playbackGain) {
    playbackGain.gain.setValueAtTime(0, nextPlayTime)
    playbackGain.gain.linearRampToValueAtTime(1, nextPlayTime + 0.01)
  }
  audioStarted = true
  source.start(nextPlayTime)
  nextPlayTime += buffer.duration / speed
}

function finishIfReady(): void {
  if (!generationFinished || sources.size > 0 || !context) return
  if (context.currentTime + 0.01 < nextPlayTime) {
    clearTimeout(finishTimer)
    finishTimer = setTimeout(finishIfReady, 80)
    return
  }
  activeRequest = ''
  pendingByte = null
  publish(null)
}

function stopPlayback(): void {
  activeRequest = ''
  generationFinished = false
  clearTimeout(finishTimer)
  for (const source of sources) {
    source.onended = null
    try {
      source.stop()
    } catch {
      /* Already ended. */
    }
    source.disconnect()
  }
  sources.clear()
  playbackGain?.disconnect()
  playbackGain = null
  audioStarted = false
  pendingByte = null
  nextPlayTime = context?.currentTime ?? 0
  void anodex.speech.stop()
  publish(null)
}

function fail(reason: string): void {
  stopPlayback()
  notifyError('Anodex could not read this reply aloud', reason)
}

export function toggleReadAloud(token: string, text: string): void {
  const ctx = audioContext()
  if (!ctx) return
  if (state?.token === token && state.phase === 'playing') {
    void ctx.suspend()
    publish({ token, phase: 'paused' })
    return
  }
  if (state?.token === token && state.phase === 'paused') {
    void ctx.resume()
    publish({ token, phase: 'playing' })
    return
  }
  if (state?.token === token && state.phase === 'preparing') {
    stopPlayback()
    return
  }
  stopPlayback()
  if (ctx.state === 'suspended') void ctx.resume()
  const requestId = `speech-${++requestCounter}`
  activeRequest = requestId
  nextPlayTime = ctx.currentTime + 0.025
  generationFinished = false
  audioSubscription ??= anodex.speech.onAudio(receiveAudio)
  publish({ token, phase: 'preparing' })
  void anodex.speech
    .speak(requestId, text)
    .then((result) => {
      if (activeRequest !== requestId) return
      if (!result.ok) {
        fail(result.error.detail ?? result.error.message)
        return
      }
      generationFinished = true
      publish(sources.size ? { token, phase: 'playing' } : null)
      finishIfReady()
    })
    .catch((error: unknown) => {
      if (activeRequest === requestId)
        fail(error instanceof Error ? error.message : 'Speech generation failed.')
    })
}

export function stopReadAloud(): void {
  stopPlayback()
  if (context?.state === 'suspended') void context.resume()
}
