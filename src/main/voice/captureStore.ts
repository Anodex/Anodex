import { app } from 'electron'
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '../utils/logger'

const log = createLogger('voice')

/**
 * Keeping the audio, which is off by default and stays off.
 *
 * `docs/HANDOFF_VOICE.md` D9 says audio never leaves the machine and is not
 * retained. This is the exception that proves it: a second switch, separate from
 * the one that turns voice on at all, so that nothing writes a recording to disk
 * because somebody enabled speaking.
 *
 * It exists for one job — finding out whether a recogniser is failing on real
 * speech or only on the synthesised voice it was tested with. That question cannot
 * be answered without a real recording, and it decides weeks of work, so the
 * recording is worth taking deliberately and deleting afterwards.
 *
 * Everything it writes is in one directory, which is the whole of the undo.
 */

/** Both switches, and they are separate on purpose. */
export function voiceCaptureEnabled(): boolean {
  return process.env.ANODEX_VOICE_CAPTURE === '1'
}

/**
 * The most recordings kept.
 *
 * A session left running records every sentence in the room. The cap makes the
 * worst case a bounded folder rather than a disk filling overnight, and the oldest
 * go first because the newest are the ones somebody just said on purpose.
 */
const MAX_CAPTURES = 40

export function captureDirectory(): string {
  return join(app.getPath('userData'), 'voice', 'captures')
}

/**
 * 16 kHz mono float samples as a 16-bit WAV.
 *
 * Written here rather than reached for: a WAV header is 44 bytes of documented
 * struct, and the alternative is a dependency to avoid a function with one caller.
 */
export function encodeWav(samples: Float32Array, sampleRate = 16_000): Buffer {
  const data = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i += 1) {
    // Clamped before scaling: a sample above 1 wraps to a loud click otherwise,
    // and a click at the join is exactly what a recogniser hears as a word.
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    data.writeInt16LE(Math.round(clamped * 32767), i * 2)
  }

  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16) // PCM header size
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28) // byte rate
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)

  return Buffer.concat([header, data])
}

/**
 * Write one utterance, and say where it went.
 *
 * Never throws: a failed write is a lost recording, which is a disappointment
 * rather than a reason to break the conversation it was recorded from.
 */
export function captureUtterance(samples: Float32Array): string | null {
  if (!voiceCaptureEnabled()) return null

  try {
    const directory = captureDirectory()
    mkdirSync(directory, { recursive: true })

    const existing = readdirSync(directory)
      .filter((name) => name.endsWith('.wav'))
      .sort()
    for (const stale of existing.slice(0, Math.max(0, existing.length - MAX_CAPTURES + 1))) {
      try {
        unlinkSync(join(directory, stale))
      } catch {
        // A file somebody is reading is a file to leave alone.
      }
    }

    // Sortable by name, so "oldest first" above is a string sort rather than a
    // stat of every file in the directory.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const path = join(directory, `${stamp}.wav`)
    writeFileSync(path, encodeWav(samples))
    log.info(`kept ${(samples.length / 16_000).toFixed(2)}s at ${path}`)
    return path
  } catch (error) {
    log.warn('could not keep the recording:', error)
    return null
  }
}
