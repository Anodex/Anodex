/**
 * Detect the one sentence a person uses to tell an assistant their name.
 *
 * ## Why this exists
 *
 * Memory in Anodex is entirely model-driven: the assistant decides to call
 * `remember_fact`, or nothing is stored. Across three runs of an eight-model
 * chat matrix, only five of twenty-four model-runs made that call after the
 * user said "My name is Merlin and I prefer short answers". Six models replied
 * "Got it, Merlin" and saved nothing.
 *
 * The failure is silent, which is what makes it worth code. The name stays in
 * the conversation, so recall works for the rest of the session and everything
 * looks fine; only the *next* conversation reveals that the assistant never
 * knew them. Reframing the prompt rule moved no model, and rewriting the tool
 * description to lead with its trigger moved exactly one.
 *
 * ## Why it is this narrow
 *
 * A missed capture costs nothing — the model may still call the tool, and the
 * user can say it again. A *wrong* capture writes a false fact into global
 * memory that is then recalled in every future conversation, and the user has
 * to find and delete it. The asymmetry is severe, so this matches only
 * phrasings that cannot plausibly mean anything else, and rejects everything
 * it is not sure about. It is a backstop for the canonical case, not an
 * attempt at general fact extraction.
 */

/**
 * A name here is a capitalised word of 2–30 characters: letters, plus the
 * hyphen and apostrophe that real names carry. Capitalisation is doing real
 * work — it is what separates "my name is Merlin" from "my name is just a
 * placeholder" without needing to know what a placeholder is.
 */
const NAME_CHAR = "[A-Za-z\\u00C0-\\u024F'’-]"

/**
 * The trailing lookahead makes the length a real limit rather than a truncation
 * point. Without it, a 60-character run of letters matches the first 30 and
 * gets stored as a name — the bound has to reject the input, not trim it.
 */
const NAME = `[A-Z]${NAME_CHAR}{1,29}(?!${NAME_CHAR})`

/**
 * Only phrasings where the subject is unmistakably the speaker.
 *
 * "I'm X" is deliberately absent: "I'm tired", "I'm not sure", "I'm Merlin"
 * are the same shape, and the first two are far more common in conversation
 * than the third.
 */
const PATTERNS = [
  // The lead-in spells out both cases rather than using the `i` flag, because
  // the flag would apply to the capture as well — and the capital letter is the
  // whole signal separating "my name is Merlin" from "my name is just a
  // placeholder". Sentence-initial "My" has to match; lowercase "merlin" must
  // not.
  new RegExp(`\\b[Mm]y name(?:'s|’s| is)\\s+(${NAME})`, 'u'),
  new RegExp(`\\b[Cc]all me\\s+(${NAME})\\b`, 'u')
]

/**
 * Words that pass the capitalisation test but are never the answer.
 *
 * Sentence-initial capitalisation makes these reachable — "My name is Not
 * important" is unusual, but "Call me Later" is a real thing someone types.
 */
const NOT_A_NAME = new Set([
  'A',
  'An',
  'The',
  'Not',
  'No',
  'Just',
  'Actually',
  'Sorry',
  'Later',
  'Back',
  'Anything',
  'Whatever',
  'Something',
  'Nothing',
  'It',
  'That',
  'This',
  'My',
  'Your',
  'In',
  'On'
])

/**
 * The name the user just gave for themselves, or null.
 *
 * Returns the first name-shaped token only: "My name is Merlin Shaw" stores
 * "Merlin", because a first name is what an assistant should use and a
 * surname is more than was asked for.
 */
export function findStatedName(text: string): string | null {
  if (!text) return null
  for (const pattern of PATTERNS) {
    const match = pattern.exec(text)
    if (!match) continue
    const name = match[1]
    // A negation sits between the phrase and the capture in "my name is not
    // important", so it never reaches here as the capture — but "Not" itself
    // can, when someone capitalises it.
    if (NOT_A_NAME.has(name)) return null
    return name
  }
  return null
}

/** What {@link identityToCapture} needs to decide whether to store a name. */
export interface IdentityCaptureInput {
  /** The turn's surface. Only `'chat'` captures — see below. */
  surface: string | undefined
  /** The user's message for this turn. */
  prompt: string
  /** Every tool the turn actually called. */
  calledTools: readonly string[]
}

/**
 * The name this turn should store, or null to store nothing.
 *
 * Three conditions, each removing a way this could be wrong:
 *
 * - **Chat only.** An agent run or a scheduled task is not a conversation with
 *   a person, and a goal that happens to contain "my name is" in a file it is
 *   editing must not write to the user's global memory.
 * - **Only when the model did not already save.** If `remember_fact` was
 *   called, the model handled it, and a second write risks a near-duplicate
 *   entry saying the same thing in different words.
 * - **Only an unmistakable self-introduction**, per {@link findStatedName}.
 */
export function identityToCapture(input: IdentityCaptureInput): string | null {
  if (input.surface !== 'chat') return null
  if (input.calledTools.includes('remember_fact')) return null
  return findStatedName(input.prompt)
}
