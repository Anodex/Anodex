import { app } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createLogger } from '../utils/logger'
import { planSpeech, type SpeechChunk } from './speechPlan'

const log = createLogger('voice')

/**
 * Text in, Arc's voice out.
 *
 * ## What this is made of, and what it costs
 *
 * Nothing new ships for this. `llama-tts` is already inside the llama.cpp archive
 * `prepare-llama-server.mjs` downloads and extracts whole, so the binary has been
 * sitting beside `llama-server` in every build for as long as the vision runtime
 * has. The installer does not grow by a byte.
 *
 * The model does have to be fetched, once, and is deliberately not bundled — the
 * same bargain as the vision models, and it keeps the download for people who
 * never turn voice on at zero.
 *
 * ## Why it generates a sentence at a time
 *
 * Three reasons, and the third is the one that is easy to miss.
 *
 * A sentence generated on its own gets a shape — a rise on a question, a fall on
 * a stop — that the same sentence never gets buried in a paragraph. The pauses
 * between them become ours to choose rather than the model's, and the model's own
 * are nearly three times too long. And the first sentence can be spoken while the
 * second is still being made, which is most of what makes a voice feel immediate
 * rather than batched.
 *
 * ## What it costs, measured
 *
 * Every call spends about **2.1 seconds** starting the process and loading a
 * 1.8 GB model, and then generates at two to three times realtime. That overhead
 * is the dominant cost of a short sentence and it is paid once per chunk, so a
 * three-sentence reply took 12.9 seconds to make 9.2 seconds of audio.
 * Overlapping two at a time brings that to 10.4, which is still behind playback.
 *
 * So this is honest about what it is: **good enough to read a finished reply
 * aloud, and not yet good enough to hold a conversation.** A play button can
 * spend a few seconds preparing; somebody waiting for an answer cannot.
 *
 * Fixing it properly means a process that stays loaded between sentences, which
 * `llama-tts` does not offer — that is a runner of our own, and it is the price
 * of stage 3 rather than of this.
 *
 * ## Why every chunk uses the same reference clip
 *
 * Because without one the model invents a new speaker for every sentence — 119,
 * 154 and 104 Hz inside a single reply, measured. Conditioning each chunk on the
 * one before it was tried and is worse over a real reply: 59 Hz of spread against
 * 24, because an odd chunk becomes the reference for the next and the error
 * compounds. One fixed clip, every time, never chained.
 */

export interface SpokenChunk {
  /** The words this audio says. */
  text: string
  /** 24 kHz mono 16-bit PCM, already trimmed. No wav header. */
  pcm: Buffer
  /** Silence to play after it, in milliseconds. */
  pauseAfterMs: number
}

export interface SpeakOptions {
  /** Called as each chunk is ready, so playback can start before the rest exists. */
  onChunk?: (chunk: SpokenChunk, index: number, total: number) => void
  /** Checked between chunks: a reply nobody is listening to should stop being made. */
  cancelled?: () => boolean
  /** How many sentences to generate at once. See {@link DEFAULT_CONCURRENCY}. */
  concurrency?: number
}

/**
 * How many sentences are generated at the same time.
 *
 * Measured: every call spends about **2.1 seconds** starting the process and
 * loading a 1.8 GB model, and then generates at two to three times realtime. So a
 * three-sentence reply paid that toll three times and took 12.9 seconds to make
 * 9.2 seconds of audio — slower than it plays, which would have made streaming
 * pointless.
 *
 * The toll is per process, and the processes are independent, so overlapping them
 * hides it behind work that was happening anyway.
 *
 * Two rather than more, because each one holds its own copy of the model on the
 * GPU and the chat model is already there. Two is roughly 4.6 GB, which fits
 * beside a 27B at Q4 on a 24 GB card; three might not, and a voice that makes
 * chat fail is a bad trade.
 */
export const DEFAULT_CONCURRENCY = 2

/** What the phone captures and what the model produces, which is not a coincidence. */
export const SPEECH_RATE = 24_000

/**
 * Where the voice model lives once it has been fetched.
 *
 * Under `userData` rather than in the install, so an update does not throw away
 * two gigabytes somebody already waited for.
 */
export function voiceModelDirectory(): string {
  return join(app.getPath('userData'), 'voice')
}

export function voiceModelPaths(): { model: string; projector: string } {
  const dir = voiceModelDirectory()
  return {
    model: join(dir, 'qwen3-tts.gguf'),
    projector: join(dir, 'qwen3-tts-mmproj.gguf')
  }
}

export function voiceModelReady(): boolean {
  const { model, projector } = voiceModelPaths()
  return existsSync(model) && existsSync(projector)
}

/**
 * Arc's reference clip.
 *
 * Shipped with the app rather than downloaded: it is 1.2 MB, it is the product's
 * identity, and it has to match the code that uses it.
 */
export function referenceClipPath(): string {
  const root = app.isPackaged
    ? join(process.resourcesPath, 'voice')
    : join(process.cwd(), 'resources', 'voice')
  return join(root, 'arc', 'reference.wav')
}

function ttsBinaryPath(): string {
  const override = process.env.ANODEX_LLAMA_TTS_PATH?.trim()
  if (override) return resolve(override)

  const root = app.isPackaged
    ? join(process.resourcesPath, 'llama-server')
    : join(process.cwd(), 'resources', 'llama-server')
  const name = process.platform === 'win32' ? 'llama-tts.exe' : 'llama-tts'
  return join(root, `${process.platform}-${process.arch}`, name)
}

/** Whether this machine can speak at all, without trying. */
export function speechAvailable(): boolean {
  return existsSync(ttsBinaryPath()) && existsSync(referenceClipPath()) && voiceModelReady()
}

/**
 * Read a wav, tolerating a header that is not exactly 44 bytes.
 *
 * `llama-tts` writes a plain one today. A build that added a LIST chunk would
 * otherwise come back as a click followed by the audio, which is the kind of
 * thing that gets blamed on the model.
 */
function pcmFromWav(buffer: Buffer): Buffer {
  let at = 12
  while (at + 8 <= buffer.length) {
    const id = buffer.toString('ascii', at, at + 4)
    const size = buffer.readUInt32LE(at + 4)
    if (id === 'data') return buffer.subarray(at + 8, at + 8 + size)
    at += 8 + size + (size % 2)
  }
  throw new Error('no audio in the generated wav')
}

/**
 * Drop the silence the model pads onto both ends.
 *
 * Measured: 510 ms of nothing before the first word, and a chunk of "Good
 * morning." that was 1.52 s long to say 0.64 s of words. Without this the pause
 * we chose is never the pause anybody hears — it is ours plus the model's, and
 * the model's is nearly three times too long.
 *
 * 30 ms of air is left at each end so no word is clipped at its own attack.
 */
function trimSilence(pcm: Buffer, threshold = 250): Buffer {
  const frame = SPEECH_RATE / 100
  const loudAt = (index: number): boolean => {
    let sum = 0
    for (let i = 0; i < frame * 2 && index + i + 1 < pcm.length; i += 2) {
      const sample = pcm.readInt16LE(index + i)
      sum += sample * sample
    }
    return Math.sqrt(sum / frame) > threshold
  }

  let start = 0
  while (start < pcm.length - frame * 2 && !loudAt(start)) start += frame * 2
  let end = pcm.length - frame * 2
  while (end > start && !loudAt(end)) end -= frame * 2

  const pad = Math.round(SPEECH_RATE * 0.03) * 2
  return pcm.subarray(Math.max(0, start - pad), Math.min(pcm.length, end + frame * 2 + pad))
}

/** Silence, as PCM, for the gap after a chunk. */
export function silencePcm(ms: number): Buffer {
  return Buffer.alloc(Math.round((SPEECH_RATE * ms) / 1000) * 2)
}

async function generate(text: string, into: string): Promise<Buffer> {
  const { model, projector } = voiceModelPaths()
  const args = [
    '-m',
    model,
    '-mm',
    projector,
    '-p',
    text,
    '--tts-lang',
    'en',
    '--tts-speaker-file',
    referenceClipPath(),
    '-ngl',
    '99',
    '-o',
    into
  ]

  await new Promise<void>((done, fail) => {
    execFile(ttsBinaryPath(), args, { timeout: 120_000 }, (error) => {
      // Rejected with a real Error, so a failure that reaches a log or a
      // diagnostics entry carries a stack rather than a bare string.
      if (error) fail(error instanceof Error ? error : new Error('llama-tts failed'))
      else done()
    })
  })
  return trimSilence(pcmFromWav(await readFile(into)))
}

/**
 * Say a reply.
 *
 * Chunks are delivered through `onChunk` as they are made, and the whole thing is
 * returned as well — a caller that wants to stream uses the first, a caller that
 * wants a file uses the second, and neither has to know about the other.
 */
export async function speak(text: string, options: SpeakOptions = {}): Promise<SpokenChunk[]> {
  const plan = planSpeech(text)
  if (plan.length === 0) return []

  const scratch = join(app.getPath('temp'), `anodex-voice-${process.pid}`)
  await mkdir(scratch, { recursive: true })

  const spoken: SpokenChunk[] = []
  const startedAt = Date.now()

  // Started ahead, delivered in order. Generation overlaps; the caller still
  // hears sentence two after sentence one, because audio that arrives out of
  // order is worse than audio that arrives late.
  const width = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY)
  const inFlight = new Map<number, Promise<Buffer>>()
  const start = (index: number): void => {
    if (index >= plan.length || inFlight.has(index)) return
    inFlight.set(index, generate(plan[index].text, join(scratch, `chunk-${index}.wav`)))
  }

  try {
    for (let i = 0; i < width; i += 1) start(i)

    for (const [index, chunk] of plan.entries()) {
      // Checked between chunks rather than during: a half-generated sentence is
      // wasted either way, and stopping mid-word leaves a process orphaned.
      if (options.cancelled?.()) {
        log.info(`stopped after ${index} of ${plan.length} chunks`)
        break
      }

      start(index)
      const pcm = await (inFlight.get(index) as Promise<Buffer>)
      inFlight.delete(index)
      // Only once one is done, so the number running never exceeds the width.
      start(index + width)

      const ready: SpokenChunk = { text: chunk.text, pcm, pauseAfterMs: chunk.pauseAfterMs }
      spoken.push(ready)
      options.onChunk?.(ready, index, plan.length)
    }
  } finally {
    // Anything still running belongs to a reply nobody is waiting for. Its
    // rejection is not interesting, but an unhandled one would be.
    for (const pending of inFlight.values()) pending.catch(() => {})
    await rm(scratch, { recursive: true, force: true })
  }

  const seconds = spoken.reduce((total, c) => total + c.pcm.length / 2 / SPEECH_RATE, 0)
  log.info(
    `spoke ${seconds.toFixed(1)}s in ${spoken.length} chunks, ` +
      `took ${((Date.now() - startedAt) / 1000).toFixed(1)}s`
  )
  return spoken
}

/** Everything joined, with the pauses in, as one wav. For saving or for a file. */
export async function speakToWav(text: string, into: string): Promise<number> {
  const chunks = await speak(text)
  const parts: Buffer[] = []
  chunks.forEach((chunk, index) => {
    parts.push(chunk.pcm)
    if (index < chunks.length - 1 && chunk.pauseAfterMs > 0) {
      parts.push(silencePcm(chunk.pauseAfterMs))
    }
  })
  const data = Buffer.concat(parts)
  await writeFile(into, Buffer.concat([wavHeader(data.length), data]))
  return data.length / 2 / SPEECH_RATE
}

/** 44 bytes of documented struct, rather than a dependency with one caller. */
export function wavHeader(dataBytes: number, rate = SPEECH_RATE): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataBytes, 40)
  return header
}

export { planSpeech }
export type { SpeechChunk }
