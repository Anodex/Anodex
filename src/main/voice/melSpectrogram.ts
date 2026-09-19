/**
 * Audio to log-mel frames: the front end every recogniser in the plan needs, and
 * the first piece of speech that is unambiguously ours.
 *
 * ## Why write this rather than take it
 *
 * It is the one part of recognition that is arithmetic rather than weights. A mel
 * spectrogram is a window, a Fourier transform, a triangular filterbank and a
 * logarithm — a few hundred lines that behave identically everywhere, with no
 * training, no licence and nothing to download. Taking somebody's implementation
 * here would add a dependency to avoid writing code we can test exactly, which is
 * the worst trade in the project.
 *
 * ## The numbers, and why they are not ours to choose
 *
 * The defaults below are Whisper's, and they are deliberate: a recogniser is
 * trained against a specific front end, and feeding it a spectrogram computed with
 * a different window or a different filterbank is feeding it a language it has
 * never heard. The model gets the front end it expects or it gets nonsense, so
 * these constants belong to whatever weights we load rather than to taste.
 *
 * 16 kHz, 25 ms window (400 samples), 10 ms hop (160 samples), 80 mel bands from
 * 0 Hz to 8 kHz, natural log, floored and normalised the way Whisper's own
 * preprocessing does it.
 *
 * ## What it is not
 *
 * Not streaming state. Each call is a pure function of the samples handed to it,
 * so a caller decides what a chunk is — see `utterance.ts`, which does the
 * deciding. Keeping the transform pure is what makes it testable against values
 * worked out by hand.
 */

export interface MelOptions {
  sampleRate: number
  /** Samples per analysis window. */
  frameSize: number
  /** Samples between the start of one window and the next. */
  hopSize: number
  /** Number of triangular filters. */
  bands: number
  lowHz: number
  highHz: number
}

/** Whisper's front end. Changing any of these means the weights hear a different world. */
export const WHISPER_MEL: MelOptions = {
  sampleRate: 16_000,
  frameSize: 400,
  hopSize: 160,
  bands: 80,
  lowHz: 0,
  highHz: 8_000
}

/**
 * Mel from hertz, O'Shaughnessy's formula.
 *
 * The 2595/700 constants are the ones Whisper, Kaldi and librosa's HTK mode all
 * use. There is a second convention in the wild (Slaney's, linear below 1 kHz)
 * that produces a visibly different filterbank — picking the wrong one is a
 * plausible way to build something that looks right and recognises badly.
 */
export function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700)
}

export function melToHz(mel: number): number {
  return 700 * (10 ** (mel / 2595) - 1)
}

/**
 * A Hann window, periodic rather than symmetric.
 *
 * Periodic (dividing by N, not N-1) because that is what every audio pipeline uses
 * for spectral analysis, and what the models were trained against. The difference
 * is one sample and it is the kind of thing nobody notices and nothing tells you
 * about.
 */
export function hannWindow(size: number): Float64Array {
  const window = new Float64Array(size)
  for (let i = 0; i < size; i += 1) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size)
  }
  return window
}

/**
 * In-place iterative radix-2 Cooley-Tukey FFT.
 *
 * Written out rather than pulled in. It is forty lines, it is the hot loop of the
 * whole front end, and a recursive version allocating two arrays per call at 100
 * frames a second is the kind of thing that looks fine in a test and shows up as
 * latency on a phone.
 *
 * `real` and `imag` must be the same length and that length must be a power of
 * two — the caller pads, which is what `n_fft` means.
 */
export function fftInPlace(real: Float64Array, imag: Float64Array): void {
  const n = real.length
  if (n !== imag.length) throw new Error('fft: real and imaginary parts differ in length')
  if (n === 0 || (n & (n - 1)) !== 0) throw new Error(`fft: ${n} is not a power of two`)

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[real[i], real[j]] = [real[j], real[i]]
      ;[imag[i], imag[j]] = [imag[j], imag[i]]
    }
  }

  for (let length = 2; length <= n; length <<= 1) {
    const angle = (-2 * Math.PI) / length
    const wReal = Math.cos(angle)
    const wImag = Math.sin(angle)
    for (let i = 0; i < n; i += length) {
      let curReal = 1
      let curImag = 0
      for (let j = 0; j < length / 2; j += 1) {
        const aReal = real[i + j]
        const aImag = imag[i + j]
        const bReal = real[i + j + length / 2] * curReal - imag[i + j + length / 2] * curImag
        const bImag = real[i + j + length / 2] * curImag + imag[i + j + length / 2] * curReal

        real[i + j] = aReal + bReal
        imag[i + j] = aImag + bImag
        real[i + j + length / 2] = aReal - bReal
        imag[i + j + length / 2] = aImag - bImag

        const nextReal = curReal * wReal - curImag * wImag
        curImag = curReal * wImag + curImag * wReal
        curReal = nextReal
      }
    }
  }
}

/**
 * The triangular filterbank, as a flat matrix of `bands × (fftSize / 2 + 1)`.
 *
 * Built once and reused: it depends only on the geometry, and rebuilding it per
 * frame would be most of the cost of the front end.
 *
 * Each filter rises from one mel-spaced edge to the next and falls to the one
 * after, so neighbouring filters overlap by half and every bin between the first
 * and last edge contributes to exactly two of them.
 */
export function melFilterbank(fftSize: number, options: MelOptions): Float64Array {
  const bins = fftSize / 2 + 1
  const filters = new Float64Array(options.bands * bins)

  const lowMel = hzToMel(options.lowHz)
  const highMel = hzToMel(options.highHz)

  // bands + 2 edges: every filter needs a left foot, a peak and a right foot, and
  // consecutive filters share them.
  const edges = new Float64Array(options.bands + 2)
  for (let i = 0; i < edges.length; i += 1) {
    edges[i] = melToHz(lowMel + ((highMel - lowMel) * i) / (options.bands + 1))
  }

  const binHz = options.sampleRate / fftSize

  for (let band = 0; band < options.bands; band += 1) {
    const left = edges[band]
    const centre = edges[band + 1]
    const right = edges[band + 2]

    for (let bin = 0; bin < bins; bin += 1) {
      const hz = bin * binHz
      let weight = 0
      if (hz >= left && hz <= centre && centre > left) {
        weight = (hz - left) / (centre - left)
      } else if (hz > centre && hz <= right && right > centre) {
        weight = (right - hz) / (right - centre)
      }
      filters[band * bins + bin] = weight
    }
  }

  return filters
}

/** The smallest power of two that holds `size`. */
export function fftSizeFor(size: number): number {
  let n = 1
  while (n < size) n <<= 1
  return n
}

export interface MelSpectrogram {
  /** `frames × bands`, row-major: frame 0's 80 values, then frame 1's. */
  data: Float32Array
  frames: number
  bands: number
}

/**
 * Samples in, log-mel frames out.
 *
 * Input is mono, 16-bit range as floats in [-1, 1] — the conversion from the
 * phone's PCM happens at the edge, not here, so this stays a function over audio
 * rather than over a wire format.
 *
 * Returns zero frames for audio shorter than one window rather than padding it up
 * to one. A caller that hands over 10 ms of audio has made a mistake worth seeing;
 * silently returning a frame computed mostly from zeros would hide it inside a
 * recogniser's output, where it looks like the model being wrong.
 */
export function logMelSpectrogram(
  samples: Float32Array,
  options: MelOptions = WHISPER_MEL
): MelSpectrogram {
  const { frameSize, hopSize, bands } = options
  if (samples.length < frameSize) return { data: new Float32Array(0), frames: 0, bands }

  const fftSize = fftSizeFor(frameSize)
  const bins = fftSize / 2 + 1
  const window = hannWindow(frameSize)
  const filters = melFilterbank(fftSize, options)

  const frames = Math.floor((samples.length - frameSize) / hopSize) + 1
  const out = new Float32Array(frames * bands)

  const real = new Float64Array(fftSize)
  const imag = new Float64Array(fftSize)
  const power = new Float64Array(bins)

  for (let frame = 0; frame < frames; frame += 1) {
    const start = frame * hopSize

    real.fill(0)
    imag.fill(0)
    for (let i = 0; i < frameSize; i += 1) {
      real[i] = samples[start + i] * window[i]
    }

    fftInPlace(real, imag)

    for (let bin = 0; bin < bins; bin += 1) {
      power[bin] = real[bin] * real[bin] + imag[bin] * imag[bin]
    }

    for (let band = 0; band < bands; band += 1) {
      let sum = 0
      const offset = band * bins
      for (let bin = 0; bin < bins; bin += 1) {
        sum += filters[offset + bin] * power[bin]
      }
      // Floored before the log, not after. log(0) is -Infinity, and one silent
      // frame would otherwise poison every normalisation downstream of it.
      out[frame * bands + band] = Math.log10(Math.max(sum, 1e-10))
    }
  }

  return { data: out, frames, bands }
}

/**
 * Whisper's normalisation: clamp to 8 dB below the loudest value, then map to
 * roughly [-1, 1].
 *
 * Done over the whole utterance rather than per frame, which is why it is separate
 * from the transform above: normalising each frame on its own would make silence
 * as loud as speech, since every frame would be scaled to its own maximum.
 */
export function normaliseForWhisper(mel: MelSpectrogram): MelSpectrogram {
  if (mel.frames === 0) return mel

  let max = -Infinity
  for (const value of mel.data) if (value > max) max = value

  const floor = max - 8
  const out = new Float32Array(mel.data.length)
  for (let i = 0; i < mel.data.length; i += 1) {
    out[i] = (Math.max(mel.data[i], floor) + 4) / 4
  }
  return { data: out, frames: mel.frames, bands: mel.bands }
}

/**
 * The phone's 16-bit little-endian PCM as floats in [-1, 1].
 *
 * Divided by 32768 rather than 32767: the sample range is asymmetric (-32768 to
 * 32767) and dividing by the positive peak makes the most negative sample come out
 * at -1.000031, which clips. Every audio pipeline uses 32768 for this reason.
 */
export function pcm16ToFloat(pcm: Buffer): Float32Array {
  const samples = new Float32Array(pcm.length >> 1)
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = pcm.readInt16LE(i * 2) / 32768
  }
  return samples
}

/**
 * 24 kHz down to 16 kHz, which is exactly 3:2.
 *
 * Averaging three input samples into two output samples rather than dropping every
 * third. Decimation without a filter folds everything above 8 kHz back down into
 * the audible range as aliasing — fricatives become buzzes, which is precisely the
 * part of speech a recogniser most needs to hear. A three-tap average is a crude
 * low-pass, and crude is enough here because the phone captured at 24 kHz through
 * a telephony path that has already band-limited the signal.
 */
export function downsample24to16(samples: Float32Array): Float32Array {
  const groups = Math.floor(samples.length / 3)
  const out = new Float32Array(groups * 2)
  for (let g = 0; g < groups; g += 1) {
    const a = samples[g * 3]
    const b = samples[g * 3 + 1]
    const c = samples[g * 3 + 2]
    out[g * 2] = (a + a + b) / 3
    out[g * 2 + 1] = (b + c + c) / 3
  }
  return out
}
