import { app } from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, rm, stat, copyFile, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { delimiter, dirname, join, resolve, sep } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Readable } from 'node:stream'
import { once } from 'node:events'
import { createLogger } from '../utils/logger'
import { settingsStore } from '../settings/SettingsStore'
import type { SpeechVoice } from '@shared/settings.types'

const log = createLogger('speech')
const TALKERS = {
  base: {
    name: 'qwen-talker-0.6b-base-Q8_0.gguf',
    sha256: 'd54dbaf10591421fa764ed630d764efa717ae40cd959bd48c66d4eb1af226426',
    size: 992_615_488
  },
  customvoice: {
    name: 'qwen-talker-0.6b-customvoice-Q8_0.gguf',
    sha256: '4eb38675c736ed6ac72012846ac8d6ef80e5af8bc05726870f0b3a6569588519',
    size: 968_588_544
  }
} as const
const TOKENIZER = {
  name: 'qwen-tokenizer-12hz-Q8_0.gguf',
  sha256: '1883beeed99348fc35e23dd225e9082f93f6f8c109330a33d935baa8acdbfd94',
  size: 291_150_624
} as const
type SpeechModel = keyof typeof TALKERS
function modelForVoice(voice: SpeechVoice): SpeechModel {
  return voice === 'default' || voice === 'personal' ? 'base' : 'customvoice'
}
const MODEL_REPO = 'Serveurperso/Qwen3-TTS-GGUF'
// The WAV is base64 encoded for the local registration endpoint; leave room
// for that expansion under its 32 MiB request cap.
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024

type AudioSink = (requestId: string, pcm: Uint8Array) => void

/** Owns the local Qwen TTS process and all files that belong to speech. */
export class SpeechService {
  private child?: ChildProcessWithoutNullStreams
  private origin?: string
  private apiKey?: string
  private starting?: Promise<void>
  private preparing?: Promise<void>
  private shutdownRequested = false
  private activeRequest?: AbortController
  private downloadController?: AbortController
  private registeredReferenceMtime = 0
  private registeredReferenceTranscript = ''
  private loadedModel?: SpeechModel
  private readonly verifiedFiles = new Map<string, { size: number; mtimeMs: number }>()
  private readonly speechDirectory = join(app.getPath('userData'), 'speech')
  private readonly modelsDirectory = join(this.speechDirectory, 'models')
  private readonly referencePath = join(this.speechDirectory, 'reference.wav')
  private readonly transcriptPath = join(this.speechDirectory, 'reference.txt')

  status(): {
    runtimeAvailable: boolean
    modelInstalled: boolean
    referenceReady: boolean
    engineReady: boolean
    downloadBytes: number
  } {
    const model = modelForVoice(settingsStore.get().speech.voice)
    return {
      runtimeAvailable: this.runtimePath() !== null,
      modelInstalled: [TALKERS[model], TOKENIZER].every((file) =>
        existsSync(join(this.modelsDirectory, file.name))
      ),
      referenceReady: existsSync(this.referencePath),
      engineReady: Boolean(this.child && this.origin && this.loadedModel === model),
      downloadBytes: TALKERS[model].size + TOKENIZER.size
    }
  }

  async prepare(): Promise<void> {
    if (this.preparing) return this.preparing
    const preparing = (async () => {
      await this.start()
      if (this.shutdownRequested) return
      if (settingsStore.get().speech.voice === 'personal') await this.registerReference()
    })()
    this.preparing = preparing
    try {
      await preparing
    } finally {
      if (this.preparing === preparing) this.preparing = undefined
    }
  }

  async getTranscript(): Promise<string> {
    try {
      return await readFile(this.transcriptPath, 'utf8')
    } catch {
      return ''
    }
  }

  async setTranscript(text: string): Promise<void> {
    if (text.length > 1000)
      throw new Error('The recording transcript cannot exceed 1,000 characters.')
    await mkdir(this.speechDirectory, { recursive: true })
    await writeFile(this.transcriptPath, text, 'utf8')
    await this.deleteRegisteredReference()
    if (
      this.child &&
      this.loadedModel === 'base' &&
      settingsStore.get().speech.voice === 'personal' &&
      existsSync(this.referencePath)
    )
      await this.registerReference()
  }

  async removeReference(): Promise<void> {
    this.stop()
    await this.deleteRegisteredReference()
    this.registeredReferenceMtime = 0
    this.registeredReferenceTranscript = ''
    await rm(this.referencePath, { force: true })
    await rm(this.transcriptPath, { force: true })
  }

  async chooseReference(): Promise<void> {
    const source = await this.pickWav()
    await mkdir(this.speechDirectory, { recursive: true })
    await this.deleteRegisteredReference()
    this.registeredReferenceMtime = 0
    if (resolve(source) !== resolve(this.referencePath)) await copyFile(source, this.referencePath)
    await writeFile(this.transcriptPath, '', 'utf8')
    const file = await stat(this.referencePath)
    if (file.size > MAX_REFERENCE_BYTES) {
      await rm(this.referencePath, { force: true })
      throw new Error('Choose a WAV recording smaller than 20 MB.')
    }
  }

  /** Download and verify the selected talker and shared tokenizer. */
  async downloadModels(onProgress: (received: number, total: number) => void): Promise<void> {
    await mkdir(this.modelsDirectory, { recursive: true })
    const controller = new AbortController()
    this.downloadController = controller
    const model = modelForVoice(settingsStore.get().speech.voice)
    const files = [TALKERS[model], TOKENIZER]
    const total = files.reduce((sum, file) => sum + file.size, 0)
    let base = 0
    try {
      for (const file of files) {
        const target = join(this.modelsDirectory, file.name)
        if (existsSync(target)) {
          const digest = await hashFile(target)
          if (digest === file.sha256) {
            base += (await stat(target)).size
            continue
          }
          this.verifiedFiles.delete(target)
          await rm(target, { force: true })
        }
        const response = await fetch(
          `https://huggingface.co/${MODEL_REPO}/resolve/main/${file.name}?download=true`,
          { signal: controller.signal }
        )
        if (!response.ok || !response.body) throw new Error(`Could not download ${file.name}.`)
        const part = `${target}.part`
        const output = createWriteStream(part)
        const hash = createHash('sha256')
        let current = 0
        try {
          for await (const value of Readable.fromWeb(response.body as never)) {
            const chunk = Buffer.from(value as Uint8Array)
            hash.update(chunk)
            current += chunk.length
            if (!output.write(chunk)) await once(output, 'drain')
            onProgress(base + current, total)
          }
          output.end()
          await once(output, 'finish')
          if (hash.digest('hex') !== file.sha256)
            throw new Error(`Integrity check failed for ${file.name}.`)
          await rename(part, target)
          const installed = await stat(target)
          this.verifiedFiles.set(target, { size: installed.size, mtimeMs: installed.mtimeMs })
          base += current
        } catch (error) {
          output.destroy()
          await rm(part, { force: true })
          throw error
        }
      }
      onProgress(total, total)
    } finally {
      if (this.downloadController === controller) this.downloadController = undefined
    }
  }

  cancelModelDownload(): void {
    this.downloadController?.abort()
  }

  async speak(requestId: string, text: string, sink: AudioSink): Promise<void> {
    const clean = text.trim().slice(0, 16_000)
    if (!clean) throw new Error('There is no reply text to read.')
    if (this.activeRequest) this.stop()
    const controller = new AbortController()
    this.activeRequest = controller
    try {
      await this.start()
      if (this.activeRequest !== controller) return
      const voice = settingsStore.get().speech.voice
      if (this.loadedModel !== modelForVoice(voice)) await this.start()
      if (this.activeRequest !== controller) return
      const usesPersonalVoice = voice === 'personal' && (await this.registerReference())
      if (voice === 'personal' && !usesPersonalVoice)
        throw new Error('Choose a voice recording in Settings before using your own voice.')
      if (this.activeRequest !== controller) return
      const requestBody: { input: string; response_format: string; voice?: string } = {
        input: clean,
        response_format: 'pcm'
      }
      if (usesPersonalVoice) requestBody.voice = 'anodex-user'
      else if (voice !== 'default') requestBody.voice = voice
      const response = await fetch(`${this.origin}/v1/audio/speech`, {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(requestBody),
        signal: controller.signal
      })
      if (!response.ok || !response.body)
        throw new Error(`Speech generation failed (${response.status}).`)
      for await (const value of Readable.fromWeb(response.body as never)) {
        if (this.activeRequest !== controller) break
        const pcm = Buffer.from(value as Uint8Array)
        if (pcm.length) sink(requestId, new Uint8Array(pcm))
      }
    } catch (error) {
      if (
        this.activeRequest === controller &&
        !(error instanceof Error && error.name === 'AbortError')
      )
        throw error
    } finally {
      if (this.activeRequest === controller) this.activeRequest = undefined
    }
  }

  stop(): void {
    const activeRequest = this.activeRequest
    this.activeRequest = undefined
    activeRequest?.abort()
  }

  async shutdown(): Promise<void> {
    this.shutdownRequested = true
    this.stop()
    const child = this.child
    if (child) {
      this.child = undefined
      this.origin = undefined
      this.apiKey = undefined
      this.loadedModel = undefined
      this.registeredReferenceMtime = 0
      await stopChild(child)
    }
    await this.starting?.catch(() => undefined)
  }

  private async pickWav(): Promise<string> {
    const { dialog, BrowserWindow } = await import('electron')
    const options = {
      title: 'Choose a voice recording',
      properties: ['openFile'] as Array<'openFile'>,
      filters: [{ name: 'WAV audio', extensions: ['wav'] }]
    }
    const focused = BrowserWindow.getFocusedWindow()
    const result = focused
      ? await dialog.showOpenDialog(focused, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) throw new Error('No recording was selected.')
    const info = await stat(result.filePaths[0])
    if (info.size < 8 || info.size > MAX_REFERENCE_BYTES) {
      throw new Error('Choose a WAV recording between 8 bytes and 20 MB.')
    }
    return result.filePaths[0]
  }

  private runtimePath(): string | null {
    const root = app.isPackaged
      ? join(process.resourcesPath, 'speech-runtime')
      : join(process.cwd(), 'resources', 'speech-runtime')
    const directory = join(root, `${process.platform}-${process.arch}`)
    const marker = join(directory, '.release.json')
    if (!existsSync(marker)) return null
    try {
      const metadata = JSON.parse(readFileSync(marker, 'utf8')) as {
        binaryRelativePath?: string
      }
      const binary = resolve(directory, metadata.binaryRelativePath ?? '')
      return binary.startsWith(`${resolve(directory)}${sep}`) && existsSync(binary) ? binary : null
    } catch {
      return null
    }
  }

  private async start(): Promise<void> {
    const model = modelForVoice(settingsStore.get().speech.voice)
    if (this.starting) {
      await this.starting
      return this.start()
    }
    if (this.child && this.origin && this.apiKey && this.loadedModel === model) return
    if (this.child) await this.shutdown()
    this.shutdownRequested = false
    this.starting = this.startProcess(model)
    try {
      await this.starting
    } finally {
      this.starting = undefined
    }
  }

  private async startProcess(model: SpeechModel): Promise<void> {
    const binary = this.runtimePath()
    if (!binary) throw new Error('The local speech runtime is missing from this Anodex build.')
    for (const file of [TALKERS[model], TOKENIZER]) {
      const modelPath = join(this.modelsDirectory, file.name)
      if (!existsSync(modelPath)) {
        throw new Error('Download the local speech model in Settings before reading replies aloud.')
      }
      const info = await stat(modelPath)
      const verified = this.verifiedFiles.get(modelPath)
      if (verified?.size === info.size && verified.mtimeMs === info.mtimeMs) continue
      if (info.size !== file.size || (await hashFile(modelPath)) !== file.sha256)
        throw new Error(
          `The local speech model failed its integrity check (${file.name}). Download it again.`
        )
      this.verifiedFiles.set(modelPath, { size: info.size, mtimeMs: info.mtimeMs })
    }
    const port = await reservePort()
    if (this.shutdownRequested) throw new Error('Speech preparation was cancelled.')
    const apiKey = randomBytes(24).toString('hex')
    const directory = dirname(binary)
    const child = spawn(
      binary,
      [
        '--model',
        join(this.modelsDirectory, TALKERS[model].name),
        '--codec',
        join(this.modelsDirectory, TOKENIZER.name),
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--api-key',
        apiKey,
        '--no-fa'
      ],
      { cwd: directory, windowsHide: true, stdio: 'pipe', env: this.runtimeEnvironment(directory) }
    )
    child.stdout.on('data', () => undefined)
    child.stderr.on('data', () => undefined)
    let spawnFailure: Error | undefined
    child.once('error', (error) => {
      spawnFailure = error
      log.error('Speech runtime failed to start:', error.message)
    })
    this.child = child
    this.origin = `http://127.0.0.1:${port}`
    this.apiKey = apiKey
    child.once('exit', () => {
      if (this.child !== child) return
      this.child = undefined
      this.origin = undefined
      this.apiKey = undefined
      this.loadedModel = undefined
      this.registeredReferenceMtime = 0
      this.registeredReferenceTranscript = ''
      log.error('The local speech runtime exited unexpectedly.')
    })
    try {
      await waitForHealth(this.origin, apiKey, child, () => spawnFailure)
      if (this.shutdownRequested) throw new Error('Speech preparation was cancelled.')
      this.loadedModel = model
    } catch (error) {
      if (this.child === child) {
        this.child = undefined
        this.origin = undefined
        this.apiKey = undefined
        this.loadedModel = undefined
        this.registeredReferenceMtime = 0
        this.registeredReferenceTranscript = ''
        await stopChild(child)
      }
      throw error
    }
  }

  private async registerReference(): Promise<boolean> {
    if (!existsSync(this.referencePath)) return false
    const referenceStat = await stat(this.referencePath)
    const referenceTranscript = await this.getTranscript()
    if (
      this.registeredReferenceMtime === referenceStat.mtimeMs &&
      this.registeredReferenceTranscript === referenceTranscript
    )
      return true
    await this.deleteRegisteredReference()
    const wav = await readFile(this.referencePath)
    const response = await fetch(`${this.origin}/v1/audio/voices`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        name: 'anodex-user',
        ref_text: referenceTranscript,
        wav_b64: wav.toString('base64')
      })
    })
    if (!response.ok)
      throw new Error('Could not load your voice recording into the local speech engine.')
    this.registeredReferenceMtime = referenceStat.mtimeMs
    this.registeredReferenceTranscript = referenceTranscript
    return true
  }

  private async deleteRegisteredReference(): Promise<void> {
    if (!this.origin || !this.registeredReferenceMtime) return
    try {
      await fetch(`${this.origin}/v1/audio/voices/anodex-user`, {
        method: 'DELETE',
        headers: this.headers({})
      })
    } catch (error) {
      log.warn('Could not remove the previous voice from the local engine:', error)
    }
    this.registeredReferenceMtime = 0
    this.registeredReferenceTranscript = ''
  }

  private headers(extra: Record<string, string>): Record<string, string> {
    return { ...extra, Authorization: `Bearer ${this.apiKey}` }
  }

  private runtimeEnvironment(directory: string): NodeJS.ProcessEnv {
    const libraryKey =
      process.platform === 'win32'
        ? 'PATH'
        : process.platform === 'darwin'
          ? 'DYLD_LIBRARY_PATH'
          : 'LD_LIBRARY_PATH'
    return {
      ...process.env,
      [libraryKey]: `${directory}${delimiter}${process.env[libraryKey] ?? ''}`
    }
  }
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return
  await new Promise<void>((done) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      done()
    }, 2000)
    child.once('exit', () => {
      clearTimeout(timer)
      done()
    })
    child.kill()
  })
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function reservePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Could not reserve a local speech port.'))
        return
      }
      server.close((error) => (error ? reject(error) : resolvePort(address.port)))
    })
  })
}

async function waitForHealth(
  origin: string,
  key: string,
  child: ChildProcessWithoutNullStreams,
  getSpawnFailure: () => Error | undefined
): Promise<void> {
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    if (getSpawnFailure()) {
      throw new Error(`Could not start the local speech runtime: ${getSpawnFailure()?.message}`)
    }
    if (child.exitCode !== null) throw new Error('The local speech runtime stopped while loading.')
    try {
      const response = await fetch(`${origin}/health`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(1500)
      })
      if (response.ok) return
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 300))
    }
  }
  throw new Error(
    'The local speech model took too long to load. Try again after closing other apps.'
  )
}
