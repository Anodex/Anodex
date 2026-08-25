import { basename, capitalize, shorten } from './labelText'

/**
 * What Anodex is doing *right now*, phrased the way a person would say it:
 * "Reading camera.py", "Running npm test", "Searching 'orbital mechanics'".
 *
 * The live indicator used to read "Preparing next step" between calls and echo
 * the raw tool title during one. Both are true and neither is useful: the first
 * describes a state rather than a task, and the second is written in the tense
 * of a finished record ("Read camera.py") while the work is still happening.
 *
 * Derived from the tool title Anodex itself emitted, never from the model's
 * narration — the same rule `summarizeWork` follows, for the same reason. A
 * status line that reported an intention would claim work that has not
 * happened yet, and this one sits directly above a spinner.
 *
 * Titles are written for people and open with a plain verb, so the only
 * transformation needed is that verb's present participle. Answers `null` for
 * a title that does not open with a verb this knows ("Git status", "Semantic
 * search 'x'", "Info package.json"), leaving the caller to show the title
 * unchanged rather than risk inventing grammar for it.
 */
export function activityPhrase(title: string, max = MAX_PHRASE_CHARS): string | null {
  const parsed = splitLeadingVerb(title)
  if (!parsed) return null

  const participle = PARTICIPLES[parsed.verb]
  if (!participle) return null

  if (parsed.rest === '') return capitalize(participle)
  const subject = PATH_SUBJECT_VERBS.has(parsed.verb) ? condensePaths(parsed.rest) : parsed.rest
  return shorten(`${capitalize(participle)} ${subject}`, max)
}

/** A one-line ticker; longer than this and the end is off the edge anyway. */
const MAX_PHRASE_CHARS = 56

/**
 * The opening word and everything after it. A trailing colon is part of the
 * title's punctuation ("Run: npm test", "Check: types"), not part of the verb.
 */
function splitLeadingVerb(title: string): { verb: string; rest: string } | null {
  const match = /^\s*([A-Za-z]+):?(?:\s+(.*))?$/.exec(title)
  if (!match) return null
  return { verb: match[1].toLowerCase(), rest: (match[2] ?? '').trim() }
}

/**
 * Present participles, spelled out rather than derived. English doubles a final
 * consonant in some of these and drops a final "e" in others, and a rule that
 * gets "runing" or "moveing" wrong is worse than a short list that cannot.
 */
const PARTICIPLES: Readonly<Record<string, string>> = {
  add: 'adding',
  apply: 'applying',
  approve: 'approving',
  archive: 'archiving',
  check: 'checking',
  commit: 'committing',
  copy: 'copying',
  create: 'creating',
  delete: 'deleting',
  draft: 'drafting',
  edit: 'editing',
  fetch: 'fetching',
  find: 'finding',
  finish: 'finishing',
  flag: 'flagging',
  forward: 'forwarding',
  install: 'installing',
  list: 'listing',
  mark: 'marking',
  move: 'moving',
  open: 'opening',
  outline: 'outlining',
  propose: 'proposing',
  read: 'reading',
  remove: 'removing',
  rename: 'renaming',
  reply: 'replying',
  run: 'running',
  save: 'saving',
  search: 'searching',
  send: 'sending',
  summarize: 'summarizing',
  update: 'updating',
  view: 'viewing',
  write: 'writing'
}

/**
 * Verbs whose subject is a single file, where the directory is noise in a
 * one-line ticker and the tool card below still shows the full path.
 *
 * Deliberately narrow. A command's text is not a path even when it contains
 * one — shortening `python src/game/main.py` to `python main.py` would name a
 * command that was never run — and a directory listing loses its subject
 * entirely if `src/main` becomes `main`.
 */
const PATH_SUBJECT_VERBS: ReadonlySet<string> = new Set(['read', 'edit', 'write', 'view'])

/** Replace path-like words with their final segment, leaving everything else alone. */
function condensePaths(text: string): string {
  return text
    .split(' ')
    .map((word) => (isPathLike(word) ? basename(word) : word))
    .join(' ')
}

/** A word carrying a directory separator, on either platform's spelling. */
function isPathLike(word: string): boolean {
  return word.includes('/') || word.includes(String.fromCharCode(92))
}
