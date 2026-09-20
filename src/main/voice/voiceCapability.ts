import { settingsStore } from '../settings/SettingsStore'

/**
 * Whether voice exists at all, on this build and on this connection.
 *
 * A setting now, not an environment variable. It was one while stage 1 was a
 * loop that echoed audio back to measure latency: a switch in Settings that
 * turns on a test is worse than no switch, and the comment here said it would
 * become real "when there is something to hear". There is — a reply can be read
 * aloud — so this is that.
 *
 * `ANODEX_VOICE` survives as an override, which is not hedging: it is how a
 * test sets the answer without a settings file, and how a build can be started
 * with voice forced on or off without touching somebody's saved preferences.
 * `1` forces on, `0` forces off, anything else defers to the setting.
 *
 * Read through a function rather than a module constant so both can change
 * underneath a running app without either having to defeat module caching.
 */

/**
 * The name voice announces itself under.
 *
 * `feature.major` — if the audio framing changes shape this becomes `voice.2`, an
 * older peer does not recognise it, and the feature is simply absent there rather
 * than broken. See `../remote/capabilities`.
 */
export const VOICE_CAPABILITY = 'voice.1'

/** Whether this desktop offers voice. */
export function voiceEnabled(): boolean {
  const override = process.env.ANODEX_VOICE
  if (override === '1') return true
  if (override === '0') return false
  try {
    return settingsStore.get().voice?.enabled === true
  } catch {
    // Asked before settings were readable — during early startup, or in a test
    // that never initialised the store. Off is the right answer to "is this
    // switched on?" when the answer cannot be found, and it is the answer that
    // cannot surprise anybody.
    return false
  }
}
