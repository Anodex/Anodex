import { settingsStore } from '../settings/SettingsStore'
import { PocketSpeechService, type PocketVoice } from './PocketSpeechService'
import { SpeechService } from './SpeechService'

/** Preserves the Qwen service while the local Pocket trial is selected. */
export class SpeechRouter {
  private readonly qwen = new SpeechService()
  private readonly pocket = new PocketSpeechService()

  private get usePocket(): boolean {
    return settingsStore.get().speech.engine === 'pocket'
  }

  status(): ReturnType<SpeechService['status']> & { pocketAvailable: boolean } {
    return {
      ...(this.usePocket ? this.pocket.status() : this.qwen.status()),
      pocketAvailable: this.pocket.status().runtimeAvailable
    }
  }

  listVoices(): Promise<PocketVoice[]> {
    return this.usePocket ? this.pocket.listVoices() : Promise.resolve([])
  }

  addVoice(): Promise<PocketVoice | null> {
    if (!this.usePocket) throw new Error('Choose the Pocket engine to add a voice.')
    return this.pocket.addVoice()
  }

  deleteVoice(id: string): Promise<void> {
    if (!this.usePocket) throw new Error('Choose the Pocket engine to delete a voice.')
    return this.pocket.deleteVoice(id)
  }

  async prepare(): Promise<void> {
    if (this.usePocket) {
      await this.qwen.shutdown()
      await this.pocket.prepare()
    } else {
      await this.pocket.shutdown()
      await this.qwen.prepare()
    }
  }

  getTranscript(): Promise<string> {
    return this.qwen.getTranscript()
  }
  setTranscript(text: string): Promise<void> {
    return this.qwen.setTranscript(text)
  }
  removeReference(): Promise<void> {
    return this.qwen.removeReference()
  }
  chooseReference(): Promise<void> {
    return this.qwen.chooseReference()
  }
  downloadModels(onProgress: (received: number, total: number) => void): Promise<void> {
    if (this.usePocket) throw new Error('Pocket prepares its model when first selected.')
    return this.qwen.downloadModels(onProgress)
  }
  cancelModelDownload(): void {
    this.qwen.cancelModelDownload()
  }

  async speak(
    requestId: string,
    text: string,
    sink: (id: string, pcm: Uint8Array, sampleRate: number) => void
  ): Promise<void> {
    if (this.usePocket) {
      await this.pocket.speak(requestId, text, sink)
    } else {
      await this.qwen.speak(requestId, text, (id, pcm) => sink(id, pcm, 24_000))
    }
  }

  stop(): void {
    this.qwen.stop()
    this.pocket.stop()
  }
  async shutdown(): Promise<void> {
    await Promise.all([this.qwen.shutdown(), this.pocket.shutdown()])
  }
}
