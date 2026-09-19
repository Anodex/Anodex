/**
 * Whether voice exists at all, on this build and on this connection.
 *
 * Voice is off unless `ANODEX_VOICE=1` is in the environment. Deliberately not a
 * setting yet: there is nothing a user could do with it — stage 1 is a loop that
 * echoes audio back to measure latency (`docs/HANDOFF_VOICE.md` §10), and a switch
 * in Settings that turns on a test is worse than no switch. It becomes a real
 * setting when there is something to hear.
 *
 * Read through a function rather than a module constant so a test can set the
 * variable and a build can be started with it, without either having to defeat
 * module caching.
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
  return process.env.ANODEX_VOICE === '1'
}
