import { describe, expect, it } from 'vitest'
import {
  downsample24to16,
  fftInPlace,
  fftSizeFor,
  hannWindow,
  hzToMel,
  logMelSpectrogram,
  melFilterbank,
  melToHz,
  normaliseForWhisper,
  pcm16ToFloat,
  WHISPER_MEL
} from '../melSpectrogram'

/**
 * The front end, checked against arithmetic rather than against itself.
 *
 * This is the one part of recognition with a right answer that can be worked out
 * by hand, and it is worth doing exactly that: a spectrogram that is subtly wrong
 * — the other mel convention, a symmetric window, decimation without a filter —
 * produces a recogniser that works badly rather than one that fails. The symptom
 * is "the model is not very good", which is unfalsifiable and sends everyone
 * looking in the wrong place.
 */
describe('the Fourier transform', () => {
  function dft(samples: number[]): { real: number[]; imag: number[] } {
    const n = samples.length
    const real: number[] = []
    const imag: number[] = []
    for (let k = 0; k < n; k += 1) {
      let re = 0
      let im = 0
      for (let t = 0; t < n; t += 1) {
        re += samples[t] * Math.cos((-2 * Math.PI * k * t) / n)
        im += samples[t] * Math.sin((-2 * Math.PI * k * t) / n)
      }
      real.push(re)
      imag.push(im)
    }
    return { real, imag }
  }

  it('agrees with the definition it is an optimisation of', () => {
    // The whole point of the hand-written FFT is speed, and the only thing worth
    // checking about an optimisation is that it computes the slow thing.
    const samples = [1, 2, 3, 4, 5, -6, 7, -8, 0.5, 1.5, -2.5, 3, 0, -1, 2, 1]
    const expected = dft(samples)

    const real = Float64Array.from(samples)
    const imag = new Float64Array(samples.length)
    fftInPlace(real, imag)

    for (let k = 0; k < samples.length; k += 1) {
      expect(real[k]).toBeCloseTo(expected.real[k], 9)
      expect(imag[k]).toBeCloseTo(expected.imag[k], 9)
    }
  })

  it('puts a pure tone in the bin it belongs to', () => {
    // 4 cycles across 64 samples is bin 4, and nothing else.
    const n = 64
    const real = new Float64Array(n)
    const imag = new Float64Array(n)
    for (let i = 0; i < n; i += 1) real[i] = Math.cos((2 * Math.PI * 4 * i) / n)

    fftInPlace(real, imag)

    const magnitude = (k: number) => Math.hypot(real[k], imag[k])
    expect(magnitude(4)).toBeCloseTo(n / 2, 6)
    expect(magnitude(3)).toBeLessThan(1e-9)
    expect(magnitude(5)).toBeLessThan(1e-9)
  })

  it('refuses a length it cannot halve', () => {
    expect(() => fftInPlace(new Float64Array(6), new Float64Array(6))).toThrow(/power of two/)
  })

  it('pads up to the next power of two', () => {
    expect(fftSizeFor(400)).toBe(512)
    expect(fftSizeFor(512)).toBe(512)
    expect(fftSizeFor(1)).toBe(1)
  })
})

describe('the mel scale', () => {
  it('is the HTK convention the models were trained against', () => {
    // 1000 Hz is ~999.99 mel under this formula. Slaney's convention — linear
    // below 1 kHz — gives a visibly different filterbank, and picking the wrong
    // one builds something that looks right and recognises badly.
    expect(hzToMel(1000)).toBeCloseTo(999.9855, 3)
    expect(hzToMel(0)).toBe(0)
  })

  it('round-trips', () => {
    for (const hz of [0, 100, 440, 1000, 4000, 8000]) {
      expect(melToHz(hzToMel(hz))).toBeCloseTo(hz, 6)
    }
  })

  it('is compressive: equal mel steps are wider in hertz as they climb', () => {
    // The property that makes it a mel scale at all.
    const low = melToHz(200) - melToHz(100)
    const high = melToHz(2200) - melToHz(2100)
    expect(high).toBeGreaterThan(low * 5)
  })
})

describe('the filterbank', () => {
  const fftSize = 512
  const bins = fftSize / 2 + 1
  const filters = melFilterbank(fftSize, WHISPER_MEL)

  it('has one triangle per band', () => {
    expect(filters.length).toBe(WHISPER_MEL.bands * bins)
  })

  it('is never negative and never above one', () => {
    for (const weight of filters) {
      expect(weight).toBeGreaterThanOrEqual(0)
      expect(weight).toBeLessThanOrEqual(1)
    }
  })

  it('gives each band a single peak', () => {
    // A triangle rises once and falls once. Two peaks would mean the edges were
    // computed out of order, which produces a filterbank that still "works".
    for (let band = 0; band < WHISPER_MEL.bands; band += 1) {
      const row = filters.subarray(band * bins, (band + 1) * bins)
      let rises = 0
      for (let bin = 1; bin < row.length; bin += 1) {
        if (row[bin] > row[bin - 1] && row[bin - 1] === 0) rises += 1
      }
      expect(rises, `band ${band} starts rising ${rises} times`).toBeLessThanOrEqual(1)
    }
  })

  it('overlaps its neighbours', () => {
    // Adjacent filters share a foot, so some bin is in both. Without the overlap
    // the bands are independent and the spectrogram loses the smoothness the
    // model expects.
    const first = filters.subarray(0, bins)
    const second = filters.subarray(bins, 2 * bins)
    const shared = [...first].some((weight, bin) => weight > 0 && second[bin] > 0)
    expect(shared).toBe(true)
  })

  it('climbs: later bands sit at higher frequencies', () => {
    const peakBin = (band: number) => {
      const row = filters.subarray(band * bins, (band + 1) * bins)
      let best = 0
      for (let bin = 1; bin < row.length; bin += 1) if (row[bin] > row[best]) best = bin
      return best
    }
    expect(peakBin(70)).toBeGreaterThan(peakBin(10))
  })
})

describe('the window', () => {
  it('is periodic, not symmetric', () => {
    // Divided by N rather than N-1. One sample of difference, invisible, and what
    // every audio pipeline and every trained model assumes.
    const window = hannWindow(8)
    expect(window[0]).toBeCloseTo(0, 12)
    expect(window[4]).toBeCloseTo(1, 12)
    expect(window[7]).toBeCloseTo(window[1], 12)
  })
})

describe('the spectrogram', () => {
  function tone(hz: number, seconds: number, rate = 16_000): Float32Array {
    const samples = new Float32Array(Math.round(seconds * rate))
    for (let i = 0; i < samples.length; i += 1) samples[i] = Math.sin((2 * Math.PI * hz * i) / rate)
    return samples
  }

  it('produces a frame every hop, after the first window', () => {
    // 1600 samples is 100 ms: one window of 400 plus 1200 more, so 1 + 7 frames.
    const mel = logMelSpectrogram(tone(440, 0.1))
    expect(mel.frames).toBe(Math.floor((1600 - 400) / 160) + 1)
    expect(mel.bands).toBe(80)
    expect(mel.data.length).toBe(mel.frames * 80)
  })

  it('returns nothing for audio shorter than one window', () => {
    // Rather than padding it out. A caller handing over 10 ms has made a mistake,
    // and a frame computed mostly from zeros hides it inside the model's output.
    expect(logMelSpectrogram(new Float32Array(399)).frames).toBe(0)
  })

  it('puts a low tone in low bands and a high tone in high bands', () => {
    const loudestBand = (hz: number) => {
      const mel = logMelSpectrogram(tone(hz, 0.2))
      const frame = mel.data.subarray(5 * mel.bands, 6 * mel.bands)
      let best = 0
      for (let band = 1; band < frame.length; band += 1) if (frame[band] > frame[best]) best = band
      return best
    }

    const low = loudestBand(200)
    const high = loudestBand(4000)
    expect(high).toBeGreaterThan(low)
    expect(low).toBeLessThan(20)
  })

  it('never returns negative infinity for silence', () => {
    // Floored before the log. One silent frame otherwise poisons every
    // normalisation downstream of it.
    const mel = logMelSpectrogram(new Float32Array(1600))
    expect(mel.frames).toBeGreaterThan(0)
    for (const value of mel.data) expect(Number.isFinite(value)).toBe(true)
  })
})

describe('normalisation', () => {
  it('is over the whole utterance, so silence stays quieter than speech', () => {
    // Per-frame normalisation would scale every frame to its own maximum and make
    // a silent frame as loud as a shouted one.
    const loud = new Float32Array(1600).map((_, i) => Math.sin((2 * Math.PI * 440 * i) / 16000))
    const withSilence = new Float32Array(3200)
    withSilence.set(loud, 0)

    const mel = normaliseForWhisper(logMelSpectrogram(withSilence))
    const first = mel.data.subarray(0, mel.bands).reduce((a, b) => a + b, 0)
    const last = mel.data.subarray((mel.frames - 1) * mel.bands).reduce((a, b) => a + b, 0)
    expect(first).toBeGreaterThan(last)
  })

  it('leaves an empty spectrogram alone', () => {
    expect(normaliseForWhisper({ data: new Float32Array(0), frames: 0, bands: 80 }).frames).toBe(0)
  })
})

describe('getting the phone audio into shape', () => {
  it('reads 16-bit little-endian, scaled so the most negative sample is -1', () => {
    // Divided by 32768, not 32767: the range is asymmetric and the positive peak
    // makes -32768 come out below -1, which clips.
    const pcm = Buffer.alloc(6)
    pcm.writeInt16LE(0, 0)
    pcm.writeInt16LE(32767, 2)
    pcm.writeInt16LE(-32768, 4)

    const samples = pcm16ToFloat(pcm)
    expect(samples[0]).toBe(0)
    expect(samples[1]).toBeCloseTo(1, 4)
    expect(samples[2]).toBe(-1)
  })

  it('turns three samples into two', () => {
    // 24kHz to 16kHz is exactly 3:2, which is why the phone captures at 24.
    const out = downsample24to16(new Float32Array(300))
    expect(out.length).toBe(200)
  })

  it('averages rather than dropping, so nothing folds back as aliasing', () => {
    // Plain decimation would fold everything above 8kHz down into speech, and
    // fricatives — the part a recogniser most needs — would become buzzes.
    const input = Float32Array.from([1, 0, 1, 0, 1, 0])
    const out = downsample24to16(input)
    // A dropped-sample version would give exactly the input back at half length.
    expect([...out].every((value) => value === 1 || value === 0)).toBe(false)
  })

  it('keeps a constant constant', () => {
    const out = downsample24to16(new Float32Array(300).fill(0.5))
    for (const value of out) expect(value).toBeCloseTo(0.5, 6)
  })
})
