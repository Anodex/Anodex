/**
 * Named, saved assistant personalities.
 *
 * Before this, `assistantStyle.globalStyle` was a single free-text field and
 * the Settings page offered a preset dropdown that merely *typed into* it —
 * picking a second preset destroyed whatever the first one had been edited
 * into, and nothing you wrote could be given a name or come back later.
 *
 * A personality is that same voice guidance with an identity: a name you chose,
 * kept alongside the others, selectable per taste. The text still reaches the
 * model through exactly one seam (the `# Assistant style` section), so nothing
 * about how a personality influences a turn is new — only that there can now be
 * more than one of them and that they survive being switched away from.
 *
 * Two deliberate structural choices:
 *
 * - **Built-ins live in code, never in settings.** Shipping them as persisted
 *   rows means a user who deletes one gets it back on the next release, or
 *   worse, keeps a stale copy of one that was since reworded. Merging them in
 *   at read time makes them read-only by construction.
 * - **There is one reader, {@link resolveActiveStyle}.** The stored free text
 *   and the selected personality are not kept in sync with each other; the
 *   resolver decides which is in force. Mirroring one into the other would be
 *   two sources of truth for the same sentence, and they would drift.
 */

/** A character: who the assistant is, and how it talks. */
export interface ChatPersonality {
  /** Stable id. Built-ins use the `builtin:` prefix; user ones use a uuid. */
  id: string
  /** Shown in the picker and, when this one is active, on every reply. */
  name: string
  /**
   * The guidance itself, in the same voice-and-tone register as the free-text
   * field it replaces. Capped by `MAX_ASSISTANT_STYLE_CHARS` at the settings
   * boundary, not here, so this module stays free of settings imports.
   */
  style: string
  /**
   * One line describing what this personality is for, under the name.
   *
   * Real names cost something the old trait labels gave away free: "Direct"
   * told you what it did, "Vale" does not. This is that signal, given back.
   */
  role?: string
  /**
   * Who they are, as opposed to how they talk. Rendered as its own prompt
   * section — identity is context, voice is instruction, and a model treats
   * them differently, so concatenating them would be the easy version and the
   * worse one.
   *
   * Capped far below `style` (see `MAX_PERSONALITY_STORY_CHARS`): both ride in
   * the system prompt on every turn, and an 8K local model has roughly 4,750
   * tokens of working room to begin with.
   */
  story?: string
  /**
   * Absolute path to the user's chosen picture, or absent for a monogram.
   *
   * A path, never the image data. Settings is one JSON file read on every
   * `get()`, and inlining a few hundred KB of base64 per personality would put
   * that cost on every read the app makes.
   */
  image?: string
  /**
   * Which identity tint the monogram uses when there is no picture. Names a
   * `--series-*`/accent token rather than carrying a colour, so the palette
   * stays with the themes and both grounds keep working.
   */
  tint?: PersonalityTint
}

/**
 * Monogram colours, reusing the chart series tokens plus the accent family.
 * Those are already validated against light and dark, so identity avoids
 * inventing hues that would then need validating separately.
 */
export const PERSONALITY_TINTS = [
  'accent',
  'violet',
  'green',
  'series-1',
  'series-2',
  'series-3',
  'series-4'
] as const

export type PersonalityTint = (typeof PERSONALITY_TINTS)[number]

/**
 * A backstory ceiling well under the voice one.
 *
 * Not squeamishness about long characters: both fields are prepended to every
 * single turn, so a thousand words of backstory is a thousand words the actual
 * work no longer has room for. The editor states the cost in tokens for the
 * same reason.
 */
export const MAX_PERSONALITY_STORY_CHARS = 1200

/** One line under the name; long enough to say what it is for, not more. */
export const MAX_PERSONALITY_ROLE_CHARS = 80

/**
 * Long enough for "Skeptical & rigorous" and a person's name, short enough that
 * a picker row stays one line at the narrowest supported window.
 */
export const MAX_PERSONALITY_NAME_CHARS = 40

/**
 * A ceiling on saved personalities, enforced at the settings boundary.
 *
 * Not a product limit — a corruption limit. Settings is a single JSON file
 * loaded on every read, and an unbounded list behind an IPC-reachable patch is
 * the shape that turns one bad renderer loop into an unopenable app.
 */
export const MAX_SAVED_PERSONALITIES = 50

const BUILT_IN_PREFIX = 'builtin:'

/**
 * The personalities every install starts with.
 *
 * These began as six quick-start presets that merely typed into a textarea, and
 * kept their wording when they became named entries -- rewording tuned text
 * would silently change the voice of anyone who had pasted one in. That wording
 * is still carried over unchanged here.
 *
 * What is new is that each is a character rather than a setting: a real name, a
 * role line, and a backstory. The names cost the signal the old labels carried
 * for free ("Direct" said what it did; "Vale" does not), which is exactly what
 * the role line gives back.
 *
 * `Anodex` leads the list and deliberately has no backstory. It is the default
 * voice, it speaks as itself, and having one entry with the field empty is what
 * shows the field is optional.
 */
export const BUILT_IN_CHAT_PERSONALITIES: readonly ChatPersonality[] = [
  {
    id: `${BUILT_IN_PREFIX}anodex`,
    name: 'Anodex',
    role: 'The default voice — clear, even, no character on top.',
    tint: 'accent',
    style: 'Answer plainly and at the length the question deserves. No persona, no padding.'
  },
  {
    id: `${BUILT_IN_PREFIX}direct`,
    name: 'Vale',
    role: 'Direct. Answer first, reasoning after.',
    tint: 'series-1',
    story:
      'Spent years as the person who had to brief a room in ninety seconds. Learned that the answer goes first and the reasoning survives on its own merits.',
    style:
      "Be direct and concise. Skip the recap at the end and don't restate what I just asked. Lead with the answer or the change, then explain reasoning only if it's non-obvious. When there's a real tradeoff, name it briefly instead of quietly picking one. If something's uncertain or could break, say so plainly instead of hedging. Match my technical level — don't explain basics unless I ask. No filler enthusiasm, no unnecessary apologies."
  },
  {
    id: `${BUILT_IN_PREFIX}friendly`,
    name: 'Wren',
    role: 'Warm, and explains the reasoning.',
    tint: 'series-2',
    story:
      'Taught for a long time before doing this. Still believes that if an explanation did not land, the explanation was wrong, not the listener.',
    style:
      "Warm but not chatty. Walk through your reasoning briefly before landing on an answer, especially for tradeoffs. Fine to ask clarifying questions instead of guessing. Celebrate real wins briefly, but don't overdo the enthusiasm."
  },
  {
    id: `${BUILT_IN_PREFIX}terse`,
    name: 'Cass',
    role: 'Terse. As few words as will do.',
    tint: 'series-3',
    story:
      'Came up writing for a 160-character pager. Never got the habit out, and never wanted to.',
    style:
      'Answer first, explanation only if asked. No recaps, no hedging, no filler. Short sentences. One idea per line when listing things.'
  },
  {
    id: `${BUILT_IN_PREFIX}encouraging`,
    name: 'Juno',
    role: 'Encouraging without the sugar.',
    tint: 'green',
    story:
      'Ran onboarding for enough nervous beginners to know that flattery is not encouragement, and that naming what already works is.',
    style:
      'Be encouraging and patient, like a good mentor. Assume I\'m capable but may be new to this specific thing. Explain the "why" behind suggestions, not just the "what". Normalize mistakes — point them out plainly and move on, no need to soften every correction. Celebrate progress without being over the top.'
  },
  {
    id: `${BUILT_IN_PREFIX}skeptical`,
    name: 'Rook',
    role: 'Skeptical. Argues with the premise.',
    tint: 'series-4',
    story:
      'A former incident reviewer who has watched a great many confident plans fail. Keeps a notebook of them, and consults it before agreeing with anything.',
    style:
      "Default skeptical. Push back on my assumptions if they don't hold up, and say so directly rather than going along with a flawed plan. Ask for evidence or reasoning before agreeing something works. Flag edge cases and failure modes proactively, even if I didn't ask. Prefer being right over being agreeable."
  },
  {
    id: `${BUILT_IN_PREFIX}funny`,
    name: 'Pip',
    role: 'Dry humour, used sparingly.',
    tint: 'violet',
    story:
      'Wrote release notes nobody read for a decade, and started hiding jokes in them to find out. Three people wrote back. Pip remembers all three.',
    style:
      "Keep it sharp and a little irreverent — dry wit is welcome, dad jokes are not banned but should be earned. Never sacrifice correctness for a joke, and never joke about something that just broke in production. Read the room: banter is fine mid-conversation, but drop the jokes entirely when I'm debugging something urgent or clearly frustrated."
  }
]

/** Whether an id names a shipped personality rather than a user-created one. */
export function isBuiltInPersonalityId(id: string): boolean {
  return id.startsWith(BUILT_IN_PREFIX)
}

/**
 * Every personality on offer: the shipped ones, then the user's own.
 *
 * A saved entry sharing a built-in's id shadows it rather than appearing
 * twice — that is what keeps a user copy working if a built-in is ever retired
 * from a later release.
 */
export function allChatPersonalities(
  saved: readonly ChatPersonality[] | undefined
): ChatPersonality[] {
  const own = saved ?? []
  const shadowed = new Set(own.map((item) => item.id))
  return [...BUILT_IN_CHAT_PERSONALITIES.filter((item) => !shadowed.has(item.id)), ...own]
}

/** Look up one personality by id, user entries winning over built-ins. */
export function findChatPersonality(
  saved: readonly ChatPersonality[] | undefined,
  id: string | null | undefined
): ChatPersonality | null {
  if (!id) return null
  return allChatPersonalities(saved).find((item) => item.id === id) ?? null
}

/** What {@link resolveActiveStyle} needs to decide which voice is in force. */
export interface ActiveStyleInput {
  /** The user's saved personalities, straight from settings. */
  saved: readonly ChatPersonality[] | undefined
  /** The selected personality id, or null for the free-text style. */
  activeId: string | null | undefined
  /** The free-text `assistantStyle.globalStyle` value. */
  globalStyle: string | null | undefined
}

/**
 * The single source of truth for which style text reaches the system prompt.
 *
 * A dangling `activeId` — the ordinary result of deleting the personality you
 * were using — falls back to the free text rather than throwing or silently
 * blanking the assistant's voice, because a delete elsewhere in Settings should
 * not be able to change how the next turn sounds without saying so.
 *
 * Always returns a string: the prompt composer tests `.trim()`, so an empty
 * string is the clean way to say "add no Assistant style section at all".
 */
export function resolveActiveStyle(input: ActiveStyleInput): string {
  const active = findChatPersonality(input.saved, input.activeId)
  if (active) return active.style
  return input.globalStyle ?? ''
}

/**
 * The active personality as an identity, not just a block of voice text.
 *
 * `resolveActiveStyle` stays the single reader for *which* voice is in force;
 * this reads the same decision and returns the whole character, so the prompt
 * can render who they are separately from how they talk. Free text has no name
 * and no backstory, which is correct: it is guidance, not a character.
 */
export function resolveActivePersona(input: ActiveStyleInput): {
  name: string | null
  story: string
  style: string
} {
  const active = findChatPersonality(input.saved, input.activeId)
  if (!active) return { name: null, story: '', style: input.globalStyle ?? '' }
  return { name: active.name, story: active.story ?? '', style: active.style }
}

/**
 * Tidy a user-typed name into something a picker can render.
 *
 * Collapsing whitespace is not cosmetic: a pasted multi-line name would break
 * the single-line picker row and, worse, make two visibly identical names
 * differ by an invisible character.
 *
 * Returns an empty string for a blank name instead of inventing a placeholder —
 * the caller knows whether that means "reject" or "keep the old name".
 */
export function normalizePersonalityName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, MAX_PERSONALITY_NAME_CHARS)
}
