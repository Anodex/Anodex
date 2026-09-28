import { app, BrowserWindow, dialog } from 'electron'
import { randomBytes } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename, delimiter, extname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { settingsStore } from '../settings/SettingsStore'

export interface PocketVoice {
  id: string
  name: string
  kind: string
}

/** How to start the engine: the native runtime when built, else the Python prototype. */
interface Launch {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  modelPath?: string
}

// The engines accept recordings up to this size.
const MAX_RECORDING_BYTES = 8 * 1024 * 1024

// Both backends reject longer input; trimming here keeps a long reply speaking
// its opening instead of failing outright.
const MAX_SPEECH_CHARACTERS = 12_000

/** Local trial adapter. Pocket's address and launch token never cross the preload bridge. */
export class PocketSpeechService {
  private child?: ChildProcessWithoutNullStreams
  private origin?: string
  private token?: string
  private starting?: Promise<void>
  private preparing?: Promise<void>
  private loaded = false
  private active?: { id: string; controller: AbortController }

  private runtime(): Launch | null {
    if (app.isPackaged) return null
    const root = resolve(
      process.env.ANODEX_VOICE_ENGINE_HOME || join(process.cwd(), '..', 'Voice Engine')
    )
    return this.nativeRuntime(root) ?? this.pythonRuntime(root)
  }

  /** The native C++ runtime from `runtime/`, with no Python or PyTorch. */
  private nativeRuntime(root: string): Launch | null {
    const runtimeRoot = join(root, 'runtime')
    const binaryName = process.platform === 'win32' ? 'anodex-voice.exe' : 'anodex-voice'
    const binary = [
      join(runtimeRoot, 'build', 'bin', 'Release', binaryName),
      join(runtimeRoot, 'build', 'bin', binaryName)
    ].find((path) => existsSync(path))
    // 8-bit weights are smallest and fastest on every processor; the runtime
    // widens them itself where that is quicker. Other precisions still work.
    const models = ['q8_0', 'f16', 'f32'].map((type) =>
      join(runtimeRoot, 'models', `pocket-en-${type}.gguf`)
    )
    const modelPath = models.find((path) => existsSync(path)) ?? models[0]
    const voices = join(runtimeRoot, 'voices')
    if (!binary || !existsSync(voices)) return null
    return {
      command: binary,
      args: [
        'serve',
        '--model',
        modelPath,
        '--voices',
        voices,
        '--data-dir',
        this.dataDirectory(),
        '--port',
        '0',
        // Stdin stays open while Anodex runs; the engine exits when it closes.
        '--exit-with-stdin'
      ],
      cwd: runtimeRoot,
      env: process.env,
      modelPath
    }
  }

  private pythonRuntime(root: string): Launch | null {
    const python = join(
      root,
      '.venv',
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
    )
    if (!existsSync(join(root, 'src', 'voice_engine', 'server.py')) || !existsSync(python))
      return null
    return {
      command: python,
      args: [
        '-m',
        'voice_engine',
        '--data-dir',
        this.dataDirectory(),
        '--backend',
        'pocket',
        'serve',
        '--port',
        '0'
      ],
      cwd: root,
      env: {
        ...process.env,
        PYTHONPATH: [join(root, 'src'), process.env.PYTHONPATH].filter(Boolean).join(delimiter)
      }
    }
  }

  status(): {
    runtimeAvailable: boolean
    modelInstalled: boolean
    referenceReady: boolean
    engineReady: boolean
    downloadBytes: number
  } {
    const runtime = this.runtime()
    return {
      runtimeAvailable: runtime !== null,
      // The Python prototype fetches its model on first load, so only the
      // native runtime can say whether the model is actually present.
      modelInstalled: runtime !== null && (!runtime.modelPath || existsSync(runtime.modelPath)),
      referenceReady: false,
      engineReady: this.loaded && Boolean(this.child),
      downloadBytes: 0
    }
  }

  async listVoices(): Promise<PocketVoice[]> {
    await this.start()
    const response = await this.request('/v1/voices')
    const payload = (await response.json()) as { voices?: PocketVoice[] }
    return Array.isArray(payload.voices) ? payload.voices : []
  }

  /** Makes a voice from a WAV the user picks; resolves `null` if they cancel. */
  async addVoice(): Promise<PocketVoice | null> {
    const options = {
      title: 'Choose a recording of the voice',
      properties: ['openFile'] as Array<'openFile'>,
      filters: [{ name: 'WAV audio', extensions: ['wav'] }]
    }
    const focused = BrowserWindow.getFocusedWindow()
    const picked = focused
      ? await dialog.showOpenDialog(focused, options)
      : await dialog.showOpenDialog(options)
    const path = picked.filePaths[0]
    if (picked.canceled || !path) return null
    if ((await stat(path)).size > MAX_RECORDING_BYTES)
      throw new Error('Choose a WAV recording smaller than 8 MB.')
    const audio = await readFile(path)
    const name = basename(path, extname(path)).trim().slice(0, 80) || 'My voice'
    this.stop()
    await this.start()
    // The prototype needs its model loaded first; the native runtime loads it itself.
    if (!this.loaded) {
      await this.request('/v1/load', {})
      this.loaded = true
    }
    const response = await this.request('/v1/enroll', {
      name,
      audio_base64: audio.toString('base64')
    })
    const voice = (await response.json()) as PocketVoice
    return { id: voice.id, name: voice.name, kind: voice.kind }
  }

  async deleteVoice(id: string): Promise<void> {
    this.stop()
    await this.start()
    await this.request(`/v1/voices/${encodeURIComponent(id)}`, undefined, undefined, 'DELETE')
  }

  async prepare(): Promise<void> {
    if (this.preparing) return this.preparing
    const preparing = (async () => {
      await this.start()
      if (!this.loaded) {
        await this.request('/v1/load', {})
        this.loaded = true
      }
      await this.request('/v1/prepare-voice', { voice_id: settingsStore.get().speech.pocketVoice })
    })()
    this.preparing = preparing
    try {
      await preparing
    } finally {
      if (this.preparing === preparing) this.preparing = undefined
    }
  }

  async speak(
    requestId: string,
    text: string,
    sink: (id: string, pcm: Uint8Array, sampleRate: number) => void
  ): Promise<void> {
    const clean = text.trim().slice(0, MAX_SPEECH_CHARACTERS)
    if (!clean) throw new Error('There is no reply text to read.')
    this.stop()
    const controller = new AbortController()
    const active = { id: requestId, controller }
    this.active = active
    try {
      await this.prepare()
      if (this.active !== active) return
      const response = await this.request(
        '/v1/speak',
        { text: clean, voice_id: settingsStore.get().speech.pocketVoice, request_id: requestId },
        controller.signal
      )
      if (!response.body) throw new Error('The voice engine returned no audio.')
      const sampleRate = Number(response.headers.get('X-Sample-Rate'))
      if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000)
        throw new Error('The voice engine returned an invalid sample rate.')
      for await (const value of Readable.fromWeb(response.body as never)) {
        if (this.active !== active) break
        const pcm = Buffer.from(value as Uint8Array)
        if (pcm.length) sink(requestId, new Uint8Array(pcm), sampleRate)
      }
    } catch (error) {
      if (this.active === active && !(error instanceof Error && error.name === 'AbortError'))
        throw error
    } finally {
      if (this.active === active) this.active = undefined
    }
  }

  stop(): void {
    const active = this.active
    this.active = undefined
    active?.controller.abort()
    if (active && this.origin) {
      void this.request('/v1/stop', { request_id: active.id }).catch(() => undefined)
    }
  }

  async shutdown(): Promise<void> {
    this.stop()
    const child = this.child
    this.child = undefined
    this.origin = undefined
    this.token = undefined
    this.loaded = false
    if (child && child.exitCode === null) child.kill()
    await this.starting?.catch(() => undefined)
  }

  private async request(
    path: string,
    body?: object,
    signal?: AbortSignal,
    method = body ? 'POST' : 'GET'
  ): Promise<Response> {
    if (!this.origin || !this.token) throw new Error('The local voice engine is not running.')
    const response = await fetch(`${this.origin}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal
    })
    if (!response.ok) {
      const detail = (await response.json().catch(() => ({}))) as { message?: string }
      throw new Error(detail.message || `The voice engine returned ${response.status}.`)
    }
    return response
  }

  private async start(): Promise<void> {
    if (this.child && this.origin) return
    if (this.starting) return this.starting
    const runtime = this.runtime()
    if (!runtime) throw new Error('The Pocket voice prototype is not installed beside Anodex.')
    const starting = this.launch(runtime)
    this.starting = starting
    try {
      await starting
    } finally {
      if (this.starting === starting) this.starting = undefined
    }
  }

  private async launch(runtime: Launch): Promise<void> {
    const token = randomBytes(32).toString('hex')
    const child = spawn(runtime.command, runtime.args, {
      cwd: runtime.cwd,
      windowsHide: true,
      stdio: 'pipe',
      env: { ...runtime.env, ANODEX_VOICE_TOKEN: token }
    })
    child.stdout.on('data', () => undefined)
    this.child = child
    this.token = token
    try {
      const origin = await new Promise<string>((resolveReady, reject) => {
        let output = ''
        const timeout = setTimeout(
          () => reject(new Error('The voice engine did not start in time.')),
          15_000
        )
        const clean = (): void => {
          clearTimeout(timeout)
          child.stderr.off('data', onData)
          child.off('error', onError)
          child.off('exit', onExit)
        }
        const onError = (error: Error): void => {
          clean()
          reject(error)
        }
        const onExit = (): void => {
          clean()
          reject(new Error('The voice engine exited during startup.'))
        }
        const onData = (value: Buffer): void => {
          output = (output + value.toString('utf8')).slice(-2048)
          const match = output.match(/Voice Engine listening on (http:\/\/127\.0\.0\.1:\d+)/)
          if (match) {
            clean()
            resolveReady(match[1])
          }
        }
        child.stderr.on('data', onData)
        child.once('error', onError)
        child.once('exit', onExit)
      })
      if (this.child !== child) throw new Error('Speech preparation was cancelled.')
      this.origin = origin
      child.stderr.on('data', () => undefined)
      child.on('error', () => undefined)
      child.once('exit', () => {
        if (this.child !== child) return
        this.child = undefined
        this.origin = undefined
        this.token = undefined
        this.loaded = false
      })
    } catch (error) {
      if (this.child === child) {
        this.child = undefined
        this.token = undefined
      }
      if (child.exitCode === null) child.kill()
      throw error
    }
  }

  private dataDirectory(): string {
    if (process.env.ANODEX_VOICE_DATA_DIR) return resolve(process.env.ANODEX_VOICE_DATA_DIR)
    return join(app.getPath('userData'), 'voice-engine')
  }
}
