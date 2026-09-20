import { existsSync, statSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { downloadFile } from '../llama/modelDownloader'
import { createLogger } from '../utils/logger'
import { voiceModelPaths } from './Speaker'

const log = createLogger('voice')

/**
 * Fetching the voice.
 *
 * Arc's reference clip ships in the app — it is 1.2 MB and it is the product's
 * identity. The model that speaks in that voice does not: 2.3 GB in an installer
 * would be an installer nobody downloads, for a feature most people will never
 * turn on. So it arrives when somebody asks for it, which is also the only
 * honest moment to ask, because that is when they have decided they want it.
 */

/**
 * The exact two files, from the repository llama.cpp's own `llama-tts` names.
 *
 * Q8_0 rather than the smaller Q4_K_M, and that is measured rather than
 * cautious: these are the weights every result in `docs/HANDOFF_VOICE.md` was
 * taken with, and quantisation costs a voice more than it costs a text model —
 * it is heard as a wobble in timbre, which is exactly what the fixed reference
 * clip exists to remove. Half a gigabyte is not worth undoing that work
 * untested.
 *
 * Apache-2.0, from the base model's card. Worth knowing before shipping a
 * downloader for it.
 */
const REPOSITORY = 'ggml-org/Qwen3-TTS-12Hz-1.7B-Base-GGUF'

interface VoiceModelFile {
  /** The name in the repository. */
  remote: string
  /** Exact size in bytes, from the repository's own listing. */
  bytes: number
  which: 'model' | 'projector'
}

const FILES: VoiceModelFile[] = [
  { remote: 'Qwen3-TTS-12Hz-1.7B-Base-Q8_0.gguf', bytes: 1_847_874_400, which: 'model' },
  { remote: 'mmproj-Qwen3-TTS-12Hz-1.7B-Base-Q8_0.gguf', bytes: 446_422_912, which: 'projector' }
]

/** What the whole download costs, so it can be said out loud before it starts. */
export const VOICE_MODEL_BYTES = FILES.reduce((total, file) => total + file.bytes, 0)

function urlFor(file: VoiceModelFile): string {
  return `https://huggingface.co/${REPOSITORY}/resolve/main/${file.remote}?download=true`
}

function localPathFor(file: VoiceModelFile): string {
  const paths = voiceModelPaths()
  return file.which === 'model' ? paths.model : paths.projector
}

export interface VoiceModelProgress {
  receivedBytes: number
  totalBytes: number
}

/** One download at a time; a second request is refused rather than raced. */
let inFlight: AbortController | null = null

export function voiceModelDownloading(): boolean {
  return inFlight !== null
}

export function cancelVoiceModelDownload(): void {
  inFlight?.abort()
}

/** How much of the model is already on disk, in bytes. */
export function voiceModelBytesPresent(): number {
  let present = 0
  for (const file of FILES) {
    const path = localPathFor(file)
    if (existsSync(path)) present += statSync(path).size
  }
  return present
}

/**
 * Fetch both files, reporting progress across the pair rather than per file.
 *
 * Progress is summed over the whole download because that is the number a person
 * is actually waiting on. Reporting two files that each go to 100% would show
 * the bar finish and start again, which reads as a fault.
 *
 * A file already on disk is skipped and counted as done, so a download
 * interrupted after the first file resumes at the second rather than starting
 * over. Partial files are not resumed — `downloadFile` removes its own `.part`
 * on failure, and a 2 GB body that cannot be range-requested is not worth
 * pretending about.
 */
export async function downloadVoiceModel(
  onProgress: (progress: VoiceModelProgress) => void
): Promise<void> {
  if (inFlight) throw new Error('The voice is already downloading')

  const controller = new AbortController()
  inFlight = controller
  try {
    await mkdir(dirname(voiceModelPaths().model), { recursive: true })

    let finishedBytes = 0
    for (const file of FILES) {
      const path = localPathFor(file)
      if (existsSync(path)) {
        finishedBytes += statSync(path).size
        onProgress({ receivedBytes: finishedBytes, totalBytes: VOICE_MODEL_BYTES })
        continue
      }

      const before = finishedBytes
      log.info(`fetching ${file.remote}`)
      await downloadFile(urlFor(file), path, controller.signal, (received) => {
        onProgress({ receivedBytes: before + received, totalBytes: VOICE_MODEL_BYTES })
      })
      finishedBytes = before + file.bytes
    }
    log.info('the voice is installed')
  } finally {
    inFlight = null
  }
}

/**
 * Delete the model, leaving the reference clip and the setting alone.
 *
 * Reclaiming 2.3 GB should not also be a decision about whether voice exists —
 * somebody clearing space still wants the button to come back when they fetch it
 * again.
 */
export async function removeVoiceModel(): Promise<void> {
  const paths = voiceModelPaths()
  await rm(paths.model, { force: true })
  await rm(paths.projector, { force: true })
  log.info('the voice was removed')
}
