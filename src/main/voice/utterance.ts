import { downsample24to16, pcm16ToFloat } from './melSpectrogram'

/**
 * Turning a stream of audio frames into things somebody said.
 *
 * The phone sends nothing while nobody is talking, so what arrives here is already
 * bursts of speech separated by gaps. This decides where one burst ends and the
 * next begins, which is the difference between handing a recogniser a sentence and
 * handing it a conversation.
 *
 * ## The gap is measured by the sender's clock, not by arrival
 *
 * Every frame carries the phone's own clock, and the distance between two frames'
 * clocks is how much silence there was between them — regardless of what the
 * network did to either. Using arrival times instead would make a Wi-Fi hiccup
 * indistinguishable from somebody pausing, and the symptom would be sentences
 * chopped in half on a bad connection. The measured round trip on this LAN already
 * varies from 16 ms to 233 ms, which is most of an endpoint on its own.
 *
 * Arrival time is still needed for one case the sender's clock cannot cover: the
 * phone stopping mid-sentence. Nothing arrives, so there is no next frame to
 * compare against, and only a timer notices. That is [tick].
 *
 * ## What this is not
 *
 * Not endpointing in the full sense. Deciding somebody has *finished* — as opposed
 * to pausing for breath — needs to know something about what they said, and that
 * belongs to stage 4 with the rest of the latency work. This is the mechanical
 * part: bytes in, utterances out, on a rule anybody can state.
 */

export interface Utterance {
  /** 16 kHz mono, ready for the front end. */
  samples: Float32Array
  /** The sender's clock at the first and last frame, so a caller can say how long. */
  startedAtMs: number
  endedAtMs: number
  frames: number
}

export interface UtteranceOptions {
  /**
   * Silence that ends an utterance.
   *
   * 600 ms rather than the phone's own 300 ms hangover: the phone's gate closes
   * after a pause, and this end should not treat the very next word as a second
   * utterance. Doubling it means a comma keeps the sentence together while a real
   * stop still ends it.
   */
  endpointMs: number

  /**
   * The longest one utterance may run before it is closed anyway.
   *
   * Whisper's window is 30 seconds and every recogniser in the plan has a limit of
   * some kind, so this is a ceiling the model imposes rather than a choice. It also
   * catches the case nobody plans for: a microphone left open beside a television,
   * which is speech by every test this code applies.
   */
  maxMs: number

  /**
   * Shorter than this and it is a noise, not a word.
   *
   * A door, a knock, a chair. The phone's gate rejects most of them, and the ones
   * that get through arrive as a single frame or two — transcribing those produces
   * confident nonsense, which is worse than silence because it looks like something
   * somebody said.
   */
  minMs: number
}

export const DEFAULT_UTTERANCE: UtteranceOptions = {
  endpointMs: 600,
  maxMs: 30_000,
  minMs: 250
}

/**
 * Audio frames in, utterances out.
 *
 * Deliberately not an event emitter: one callback, called with a finished
 * utterance, is the whole contract. Everything about buffering is private, and the
 * caller cannot reach into a half-built one — which is what stops a recogniser
 * being handed a sentence that is still being said.
 */
export class UtteranceAssembler {
  private chunks: Float32Array[] = []
  private samples = 0
  private startedAtMs = 0
  private lastAtMs = 0
  private lastArrivalMs = 0
  private frames = 0

  constructor(
    private readonly onUtterance: (utterance: Utterance) => void,
    private readonly options: UtteranceOptions = DEFAULT_UTTERANCE
  ) {}

  /** Whether anything is part-way through being said. */
  get open(): boolean {
    return this.samples > 0
  }

  /**
   * One frame of 24 kHz 16-bit mono PCM.
   *
   * @param atMs the sender's clock from the frame's header.
   * @param arrivalMs this machine's clock, for [tick] to measure against.
   */
  accept(pcm: Buffer, atMs: number, arrivalMs: number = Date.now()): void {
    if (pcm.length < 2) return

    // The gap the sender heard, not the gap the network produced.
    if (this.open && atMs - this.lastAtMs > this.options.endpointMs) {
      this.close()
    }

    const samples = downsample24to16(pcm16ToFloat(pcm))
    if (samples.length === 0) return

    if (!this.open) {
      this.startedAtMs = atMs
      this.frames = 0
    }

    this.chunks.push(samples)
    this.samples += samples.length
    this.lastAtMs = atMs
    this.lastArrivalMs = arrivalMs
    this.frames += 1

    // Closed on length rather than trimmed. A recogniser handed more than its
    // window silently drops the end, and the part it drops is the part that was
    // still being said.
    if (this.durationMs() >= this.options.maxMs) this.close()
  }

  /**
   * Called on a timer: has the phone simply stopped?
   *
   * The sender's clock cannot answer this, because the answer is that no frame
   * arrived to carry one.
   */
  tick(nowMs: number = Date.now()): void {
    if (!this.open) return
    if (nowMs - this.lastArrivalMs > this.options.endpointMs) this.close()
  }

  /** End of session. Whatever was being said is said. */
  flush(): void {
    this.close()
  }

  /** Throw away anything part-built, without delivering it. */
  reset(): void {
    this.chunks = []
    this.samples = 0
    this.frames = 0
  }

  private durationMs(): number {
    return (this.samples / 16_000) * 1000
  }

  private close(): void {
    if (!this.open) return

    const duration = this.durationMs()
    const chunks = this.chunks
    const total = this.samples
    const startedAtMs = this.startedAtMs
    const endedAtMs = this.lastAtMs
    const frames = this.frames

    this.reset()

    // Dropped after the buffer is cleared, so a run of noises cannot accumulate
    // into something long enough to pass.
    if (duration < this.options.minMs) return

    const samples = new Float32Array(total)
    let at = 0
    for (const chunk of chunks) {
      samples.set(chunk, at)
      at += chunk.length
    }

    this.onUtterance({ samples, startedAtMs, endedAtMs, frames })
  }
}
