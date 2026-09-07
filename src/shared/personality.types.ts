import type { PersonalityTint } from './chatPersonality'

/**
 * A personality, as a phone needs it.
 *
 * Deliberately not the full `ChatPersonality`. That carries `style` — the prompt
 * text itself, which can be pages long and is the user's own writing — and a
 * picture path that means nothing on another device. A phone is choosing between
 * five options, so it needs what a chooser needs: what each is called, what it does,
 * and which colour it goes by.
 */
export interface RemotePersonality {
  id: string
  name: string
  /** One line: "Direct. Answer first, reasoning after." Empty if it has none. */
  role: string
  /**
   * Which identity tint to show it in.
   *
   * Always present, unlike on the desktop's own type where it is optional — the
   * phone draws a dot for every personality, so "no tint" would mean an invisible
   * one. The default is resolved once, here, rather than in the UI.
   */
  tint: PersonalityTint
}

export interface RemotePersonalityState {
  /** Null selects the free-text style rather than a named personality. */
  active: string | null
  personalities: RemotePersonality[]
}
