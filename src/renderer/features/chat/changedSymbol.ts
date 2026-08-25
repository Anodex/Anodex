import type { ToolCallDiff } from '@shared/tools.types'

/**
 * The name of the function, class or constant a change landed inside.
 *
 * "Edited camera.py" says a file moved; it does not say what moved in it. The
 * diff already knows — the first line that differs sits inside some definition,
 * and naming it turns the label into "Edited update_focus in camera.py" without
 * asking anyone to trust a claim.
 *
 * Deliberately derived from the diff rather than from the model's narration.
 * The narration says what the model *meant* to do and is already printed
 * directly above this label; a summary that repeated it would add nothing and
 * would state an intention as though it were an outcome. What this adds is the
 * part the narration cannot promise: where the edit actually landed.
 *
 * A heuristic over source text, so it answers `null` whenever it is not
 * reasonably sure — an unfamiliar language, a change above the first
 * definition, or a whole-file rewrite where no single symbol is the subject.
 * A missing name costs a little detail; a wrong one is a small lie.
 */
export function changedSymbol(diff: ToolCallDiff | undefined): string | null {
  if (!diff) return null
  const before = diff.before.split('\n')
  const after = diff.after.split('\n')

  const firstChange = firstDifferingLine(before, after)
  if (firstChange === null) return null

  // A rewrite that differs from its very first line has no enclosing
  // definition to name, and calling the file's first function the subject
  // would be wrong more often than right.
  if (firstChange === 0) return null

  for (let index = firstChange; index >= 0; index--) {
    const name = definitionName(after[index] ?? '')
    if (name) return name
  }
  return null
}

function firstDifferingLine(before: readonly string[], after: readonly string[]): number | null {
  const shared = Math.min(before.length, after.length)
  for (let index = 0; index < shared; index++) {
    if (before[index] !== after[index]) return index
  }
  return before.length === after.length ? null : shared
}

/**
 * Definition headers across the languages Anodex is pointed at most. Ordered
 * from most specific to least so a decorated or exported form still matches.
 */
const DEFINITION_PATTERNS: readonly RegExp[] = [
  // Python, Ruby
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/,
  /^\s*class\s+([A-Za-z_]\w*)/,
  // JS/TS functions and classes, exported or not
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  // const foo = (…) => / function
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?(?:\(|function|<)/,
  // Go, Rust, C-like
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
  /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/,
  // A class method: indented, name(args) followed by an opening brace. The
  // brace is required — without it `go(2)` on its own line, an ordinary call,
  // reads as a definition and gets named as the subject of the change.
  /^\s{2,}(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$/
]

function definitionName(line: string): string | null {
  for (const pattern of DEFINITION_PATTERNS) {
    const match = pattern.exec(line)
    if (match?.[1] && !RESERVED.has(match[1])) return match[1]
  }
  return null
}

/**
 * Words the method pattern would otherwise mistake for a definition, since
 * `if (…) {` and `for (…) {` have the same shape as `render(…) {`.
 */
const RESERVED = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'else',
  'do',
  'try',
  'with',
  'match'
])
