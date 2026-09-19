import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

/**
 * Parse JSON that came off disk, rather than off the wire.
 *
 * A file is not a string literal. Anything may have written it — an editor, a
 * script, a person — and the one difference that matters is the byte order
 * mark: `U+FEFF` at the start of a UTF-8 file is legal, invisible, and makes
 * `JSON.parse` throw `Unexpected token 'U+FEFF'`.
 *
 * Not hypothetical, and not cheap. On 2026-09-17 the user's `settings.json`
 * was rewritten by something that adds a BOM — PowerShell's `Out-File` and
 * `Set-Content` both do, as does Notepad — and on the next launch Anodex could
 * not read a file that was otherwise complete and perfectly valid. Every API
 * key, every linked mail account and every preference went to
 * `settings.json.corrupt` and the app started from defaults.
 *
 * Two dozen stores read JSON this way, including the credential store and
 * every conversation. One BOM from one stray write is all it takes, so the
 * tolerance belongs here rather than at each of them.
 *
 * Tolerant of the BOM and nothing else. A truncated or malformed file must
 * still throw: the stores above are built to quarantine what they cannot read,
 * and quietly "repairing" a damaged file is how half a conversation becomes
 * the whole of it.
 */
export function parseJsonText(text: string): unknown {
  return JSON.parse(stripBom(text))
}

/**
 * {@link parseJsonText} over a file path.
 *
 * Returns `unknown` rather than a generic with an `unknown` default, which is
 * the version this started as. A generic is inferred from whatever the caller
 * asserts, so `readJsonSync(p) as Settings` made the assertion look redundant
 * to lint -- and removing it, as `--fix` cheerfully did, left `any` flowing
 * into twenty typed stores. `unknown` forces the assertion to stay, which is
 * honest: nobody knows what is in that file until something checks.
 */
export function readJsonSync(filePath: string): unknown {
  return parseJsonText(readFileSync(filePath, 'utf-8'))
}

/** {@link readJsonSync} without blocking the main process. */
export async function readJsonAsync(filePath: string): Promise<unknown> {
  return parseJsonText(await readFile(filePath, 'utf-8'))
}

/**
 * Only the leading one, and only one.
 *
 * A BOM anywhere else in a file is a real corruption rather than an encoding
 * convention, and should fail the parse like any other stray byte.
 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}
