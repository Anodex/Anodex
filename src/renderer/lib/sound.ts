import type { SoundTheme } from '@shared/settings.types'
import { useSettingsStore } from '../stores/settingsStore'

/**
 * Subtle interface feedback and notification chimes for the
 * `appearance.soundEffects` setting. Sounds are synthesized via the Web Audio
 * API so the app does not need to ship or decode separate audio assets.
 */

export type InterfaceSound = 'click' | 'toggle' | 'navigate'
export type ChimeSound = 'success' | 'error' | 'attention'

interface PlayOptions {
  /** Used by Settings controls to preview sound before/while persisting it. */
  preview?: boolean
  theme?: SoundTheme
  volume?: number
}

interface ToneSpec {
  frequency: number
  endFrequency?: number
  offset?: number
  duration: number
  peak: number
  type?: OscillatorType
}

type SoundRecipes<T extends string> = Record<SoundTheme, Record<T, ToneSpec[]>>

const INTERFACE_RECIPES: SoundRecipes<InterfaceSound> = {
  soft: {
    click: [{ frequency: 610, duration: 0.038, peak: 0.022, type: 'triangle' }],
    toggle: [
      { frequency: 560, duration: 0.045, peak: 0.025, type: 'triangle' },
      { frequency: 760, offset: 0.026, duration: 0.04, peak: 0.018, type: 'triangle' }
    ],
    navigate: [{ frequency: 430, duration: 0.055, peak: 0.025, type: 'triangle' }]
  },
  crisp: {
    click: [{ frequency: 1050, duration: 0.026, peak: 0.018, type: 'sine' }],
    toggle: [
      { frequency: 900, duration: 0.03, peak: 0.02, type: 'triangle' },
      { frequency: 1250, offset: 0.02, duration: 0.032, peak: 0.016, type: 'triangle' }
    ],
    navigate: [{ frequency: 780, duration: 0.035, peak: 0.02, type: 'triangle' }]
  },
  glass: {
    click: [
      { frequency: 1250, duration: 0.055, peak: 0.014 },
      { frequency: 1875, offset: 0.008, duration: 0.07, peak: 0.008 }
    ],
    toggle: [
      { frequency: 980, duration: 0.065, peak: 0.017 },
      { frequency: 1480, offset: 0.025, duration: 0.08, peak: 0.012 }
    ],
    navigate: [
      { frequency: 720, duration: 0.06, peak: 0.016 },
      { frequency: 1080, offset: 0.018, duration: 0.07, peak: 0.01 }
    ]
  },
  retro: {
    click: [{ frequency: 440, duration: 0.032, peak: 0.009, type: 'square' }],
    toggle: [
      { frequency: 330, duration: 0.035, peak: 0.01, type: 'square' },
      { frequency: 660, offset: 0.028, duration: 0.04, peak: 0.008, type: 'square' }
    ],
    navigate: [{ frequency: 392, duration: 0.045, peak: 0.01, type: 'square' }]
  },
  sciFi: {
    click: [
      {
        frequency: 330,
        endFrequency: 990,
        duration: 0.09,
        peak: 0.035,
        type: 'sine'
      },
      {
        frequency: 660,
        offset: 0.035,
        duration: 0.07,
        peak: 0.016,
        type: 'triangle'
      }
    ],
    toggle: [
      {
        frequency: 280,
        endFrequency: 840,
        duration: 0.08,
        peak: 0.03,
        type: 'sine'
      },
      {
        frequency: 560,
        offset: 0.045,
        duration: 0.06,
        peak: 0.014,
        type: 'triangle'
      }
    ],
    navigate: [
      {
        frequency: 420,
        endFrequency: 720,
        duration: 0.075,
        peak: 0.028,
        type: 'sine'
      }
    ]
  }
}

const CHIME_RECIPES: SoundRecipes<ChimeSound> = {
  soft: {
    success: [
      { frequency: 660, duration: 0.11, peak: 0.09 },
      { frequency: 880, offset: 0.09, duration: 0.14, peak: 0.09 }
    ],
    attention: [
      { frequency: 523, duration: 0.1, peak: 0.09 },
      { frequency: 523, offset: 0.14, duration: 0.1, peak: 0.09 }
    ],
    error: [{ frequency: 220, duration: 0.18, peak: 0.09 }]
  },
  crisp: {
    success: [
      { frequency: 880, duration: 0.07, peak: 0.065, type: 'triangle' },
      { frequency: 1175, offset: 0.06, duration: 0.09, peak: 0.07, type: 'triangle' }
    ],
    attention: [
      { frequency: 740, duration: 0.065, peak: 0.06, type: 'triangle' },
      { frequency: 740, offset: 0.1, duration: 0.065, peak: 0.06, type: 'triangle' }
    ],
    error: [{ frequency: 260, duration: 0.12, peak: 0.045, type: 'sawtooth' }]
  },
  glass: {
    success: [
      { frequency: 1047, duration: 0.15, peak: 0.045 },
      { frequency: 1319, offset: 0.07, duration: 0.17, peak: 0.04 },
      { frequency: 1568, offset: 0.14, duration: 0.2, peak: 0.035 }
    ],
    attention: [
      { frequency: 784, duration: 0.13, peak: 0.045 },
      { frequency: 1175, offset: 0.13, duration: 0.15, peak: 0.035 }
    ],
    error: [
      { frequency: 294, duration: 0.18, peak: 0.045 },
      { frequency: 196, offset: 0.08, duration: 0.2, peak: 0.04 }
    ]
  },
  retro: {
    success: [
      { frequency: 523, duration: 0.055, peak: 0.025, type: 'square' },
      { frequency: 659, offset: 0.065, duration: 0.055, peak: 0.022, type: 'square' },
      { frequency: 784, offset: 0.13, duration: 0.08, peak: 0.02, type: 'square' }
    ],
    attention: [
      { frequency: 440, duration: 0.055, peak: 0.022, type: 'square' },
      { frequency: 440, offset: 0.09, duration: 0.055, peak: 0.022, type: 'square' }
    ],
    error: [
      { frequency: 165, duration: 0.07, peak: 0.025, type: 'square' },
      { frequency: 139, offset: 0.075, duration: 0.11, peak: 0.022, type: 'square' }
    ]
  },
  sciFi: {
    success: [
      {
        frequency: 330,
        endFrequency: 660,
        duration: 0.12,
        peak: 0.05,
        type: 'sine'
      },
      {
        frequency: 660,
        endFrequency: 990,
        offset: 0.09,
        duration: 0.15,
        peak: 0.045,
        type: 'sine'
      }
    ],
    attention: [
      {
        frequency: 440,
        endFrequency: 720,
        duration: 0.08,
        peak: 0.045,
        type: 'sine'
      },
      {
        frequency: 440,
        endFrequency: 720,
        offset: 0.12,
        duration: 0.08,
        peak: 0.045,
        type: 'sine'
      }
    ],
    error: [
      {
        frequency: 360,
        endFrequency: 150,
        duration: 0.18,
        peak: 0.05,
        type: 'sawtooth'
      }
    ]
  }
}

let sharedContext: AudioContext | null = null

function getContext(): AudioContext | null {
  if (typeof window === 'undefined' || !window.AudioContext) return null
  sharedContext ??= new AudioContext()
  return sharedContext
}

function playTone(ctx: AudioContext, startAt: number, tone: ToneSpec, volume: number): void {
  const oscillator = ctx.createOscillator()
  const gain = ctx.createGain()
  oscillator.type = tone.type ?? 'sine'
  oscillator.frequency.setValueAtTime(tone.frequency, startAt)
  if (tone.endFrequency !== undefined) {
    oscillator.frequency.exponentialRampToValueAtTime(tone.endFrequency, startAt + tone.duration)
  }
  oscillator.connect(gain)
  gain.connect(ctx.destination)

  gain.gain.setValueAtTime(0, startAt)
  gain.gain.linearRampToValueAtTime(
    tone.peak * (volume / 100),
    startAt + Math.min(0.01, tone.duration / 3)
  )
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + tone.duration)

  oscillator.start(startAt)
  oscillator.stop(startAt + tone.duration)
}

function currentTheme(options?: PlayOptions): SoundTheme {
  return options?.theme ?? useSettingsStore.getState().settings?.appearance.soundTheme ?? 'soft'
}

function canPlay(options?: PlayOptions): boolean {
  return Boolean(options?.preview || useSettingsStore.getState().settings?.appearance.soundEffects)
}

function currentVolume(options?: PlayOptions): number {
  const volume =
    options?.volume ?? useSettingsStore.getState().settings?.appearance.soundVolume ?? 70
  return Math.max(0, Math.min(100, volume))
}

function playRecipe(recipe: ToneSpec[], options?: PlayOptions): void {
  if (!canPlay(options)) return
  const volume = currentVolume(options)
  if (volume === 0) return
  const ctx = getContext()
  if (!ctx) return

  void ctx.resume().catch(() => undefined)
  const now = ctx.currentTime
  for (const tone of recipe) playTone(ctx, now + (tone.offset ?? 0), tone, volume)
}

/** Play quiet, short feedback for direct manipulation of the interface. */
export function playInterfaceSound(kind: InterfaceSound, options?: PlayOptions): void {
  playRecipe(INTERFACE_RECIPES[currentTheme(options)][kind], options)
}

/** Play the completion, error, or attention chime. */
export function playChime(kind: ChimeSound, options?: PlayOptions): void {
  playRecipe(CHIME_RECIPES[currentTheme(options)][kind], options)
}

/** Preview a palette with its most representative, pleasant motif. */
export function previewSoundTheme(theme: SoundTheme): void {
  playChime('success', { preview: true, theme })
}

/** Preview the current palette at a prospective volume with one short click. */
export function previewSoundVolume(theme: SoundTheme, volume: number): void {
  playInterfaceSound('click', { preview: true, theme, volume })
}
