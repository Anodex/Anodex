import { useSettingsStore } from '../stores/settingsStore'

/**
 * Subtle completion/error chimes for the `appearance.soundEffects` setting.
 * Synthesized via the Web Audio API rather than a bundled audio asset —
 * matches this codebase's existing preference for small JS-driven effects
 * (e.g. `ChatConstellation.tsx`'s canvas animation) over binary assets.
 */

let sharedContext: AudioContext | null = null

function getContext(): AudioContext | null {
  if (typeof window === 'undefined' || !window.AudioContext) return null
  sharedContext ??= new AudioContext()
  return sharedContext
}

/** A single short, soft tone with a quick attack/decay envelope (no clicks). */
function playTone(ctx: AudioContext, frequency: number, startAt: number, duration: number): void {
  const oscillator = ctx.createOscillator()
  const gain = ctx.createGain()
  oscillator.type = 'sine'
  oscillator.frequency.value = frequency
  oscillator.connect(gain)
  gain.connect(ctx.destination)

  const peak = 0.09
  gain.gain.setValueAtTime(0, startAt)
  gain.gain.linearRampToValueAtTime(peak, startAt + 0.015)
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration)

  oscillator.start(startAt)
  oscillator.stop(startAt + duration)
}

/** Play the completion, error, or attention chime, if `appearance.soundEffects` is on. */
export function playChime(kind: 'success' | 'error' | 'attention'): void {
  if (!useSettingsStore.getState().settings?.appearance.soundEffects) return
  const ctx = getContext()
  if (!ctx) return

  void ctx.resume()
  const now = ctx.currentTime
  if (kind === 'success') {
    playTone(ctx, 660, now, 0.11)
    playTone(ctx, 880, now + 0.09, 0.14)
  } else if (kind === 'attention') {
    playTone(ctx, 523, now, 0.1)
    playTone(ctx, 523, now + 0.14, 0.1)
  } else {
    playTone(ctx, 220, now, 0.18)
  }
}
