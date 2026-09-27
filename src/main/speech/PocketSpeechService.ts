import { app } from 'electron'
import { randomBytes } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve, delimiter } from 'node:path'
import { Readable } from 'node:stream'
import { settingsStore } from '../settings/SettingsStore'

export interface PocketVoice {
  id: string
  name: string
  kind: string
}

/** Local trial adapter. Pocket's address and launch token never cross the preload bridge. */
export class PocketSpeechService {
  private child?: ChildProcessWithoutNullStreams
  private origin?: string
  private token?: string
  private starting?: Promise<void>
  private preparing?: Promise<void>
  private loaded = false
  private active?: { id: string; controller: AbortController }

  private runtime(): { root: string; python: string } | null {
    if (app.isPackaged) return null
    const root = resolve(
      process.env.ANODEX_VOICE_ENGINE_HOME || join(process.cwd(), '..', 'Voice Engine')
    )
    const python = join(
      root,
      '.venv',
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
    )
    return existsSync(join(root, 'src', 'voice_engine', 'server.py')) && existsSync(python)
      ? { root, python }
      : null
  }

  status(): {
    runtimeAvailable: boolean
    modelInstalled: boolean
    referenceReady: boolean
    engineReady: boolean
    downloadBytes: number
  } {
    const available = this.runtime() !== null
    return {
      runtimeAvailable: available,
      modelInstalled: available,
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
    const clean = text.trim().slice(0, 16_000)
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

  private async request(path: string, body?: object, signal?: AbortSignal): Promise<Response> {
    if (!this.origin || !this.token) throw new Error('The local voice engine is not running.')
    const response = await fetch(`${this.origin}${path}`, {
      method: body ? 'POST' : 'GET',
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

  private async launch(runtime: { root: string; python: string }): Promise<void> {
    const token = randomBytes(32).toString('hex')
    const dataDir = this.dataDirectory()
    const child = spawn(
      runtime.python,
      ['-m', 'voice_engine', '--data-dir', dataDir, '--backend', 'pocket', 'serve', '--port', '0'],
      {
        cwd: runtime.root,
        windowsHide: true,
        stdio: 'pipe',
        env: {
          ...process.env,
          ANODEX_VOICE_TOKEN: token,
          PYTHONPATH: [join(runtime.root, 'src'), process.env.PYTHONPATH]
            .filter(Boolean)
            .join(delimiter)
        }
      }
    )
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
