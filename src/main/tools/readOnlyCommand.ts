/**
 * Whether a shell command only looks: lists, reads, searches or checks, and cannot
 * change anything.
 *
 * Builds run these constantly — list the folder, read a file, `git status`,
 * `node --check` — and in Edits mode each one stopped the turn for an approval while
 * the file edits around it ran freely. Seen in a website build on the user's machine:
 * a request to count the lines in the project's files sat waiting until it was
 * declined, and the build stalled behind it.
 *
 * Deliberately narrow, and wrong only in the safe direction. A command is read-only
 * only when every part of it is on the lists below and it has none of the shell
 * syntax that could run something else: no separators or redirects, no
 * subexpressions or script blocks. Anything not recognised is simply not read-only
 * and keeps asking. Running a file (`node tests.js`, `npm test`) is never on the
 * list: a test can do anything.
 */

/** Characters that chain, redirect, or run a nested command in cmd, PowerShell or sh. */
const UNSAFE_SYNTAX = /[;&<>`{}()\r\n]|\$\(|@\(|\|\|/

/** Programs that only read, as the first word of a command. Lowercase. */
const READERS = new Set([
  // PowerShell
  'get-childitem',
  'gci',
  'get-content',
  'gc',
  'get-item',
  'test-path',
  'resolve-path',
  'get-location',
  'select-string',
  'sls',
  // cmd and sh
  'dir',
  'ls',
  'type',
  'cat',
  'head',
  'tail',
  'wc',
  'grep',
  'rg',
  'findstr',
  'find',
  'tree',
  'pwd',
  'echo',
  'where',
  'which',
  // Programs checked below
  'git',
  'node'
])

/** What a reader may be piped into. Lowercase. */
const FILTERS = new Set([
  'select-object',
  'select',
  'sort-object',
  'sort',
  'where-object',
  'measure-object',
  'measure',
  'group-object',
  'format-table',
  'ft',
  'format-list',
  'fl',
  'out-string',
  'convertto-json',
  'select-string',
  'sls',
  'findstr',
  'grep',
  'rg',
  'head',
  'tail',
  'wc',
  'uniq'
])

/** `git` subcommands that only read. */
const GIT_READS = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame'])

export function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed || UNSAFE_SYNTAX.test(trimmed)) return false

  const stages = trimmed.split('|').map((stage) => stage.trim())
  if (stages.some((stage) => stage.length === 0)) return false

  return stages.every((stage, index) => {
    const words = stage.split(/\s+/)
    const program = words[0].toLowerCase()
    const allowed = index === 0 ? READERS : FILTERS
    return allowed.has(program) && argumentsOnlyRead(program, words.slice(1))
  })
}

function argumentsOnlyRead(program: string, args: string[]): boolean {
  const lower = args.map((arg) => arg.toLowerCase())
  switch (program) {
    case 'git': {
      const sub = lower.find((arg) => !arg.startsWith('-'))
      return (
        sub !== undefined && GIT_READS.has(sub) && !lower.some((arg) => arg.startsWith('--output'))
      )
    }
    case 'node':
      // Only a syntax check or a version, never running a file.
      return (
        (lower.length === 1 && (lower[0] === '--version' || lower[0] === '-v')) ||
        (lower.length >= 2 && (lower[0] === '--check' || lower[0] === '-c'))
      )
    case 'find':
      return !lower.some((arg) => /^-(exec|execdir|ok|okdir|delete|fprint|fprintf|fls)$/.test(arg))
    case 'sort':
      // `sort -o file` writes the file.
      return !lower.some((arg) => arg === '-o' || arg.startsWith('--output'))
    default:
      return true
  }
}
