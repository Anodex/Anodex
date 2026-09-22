// The larger build workload: extend an existing codebase rather than fill in
// blank files.
//
// The small workload hit its ceiling — every arm scored 27 of 27, so it could
// not show a quality difference even if one existed. Four modules written from
// a spec fit comfortably in a 21,845-token window, and delegation's whole
// pitch is that the work divides *and so does the context pressure*. A task
// that applies no pressure cannot test that claim.
//
// So this one starts from a project that already exists: a shared library with
// conventions to conform to, four worked examples that use it, and six more
// commands to build the same way. Reading what is already there is now part of
// the job, which is what makes the window size matter — and what makes a
// sub-agent's fresh context a real advantage rather than a theoretical one.
//
// Usage: node scripts/bench-build-large-fixture.mjs
import fs from 'node:fs'
import path from 'node:path'

export const WORKSPACE = 'C:/Users/Owner/Desktop/Sandbox/BuildToolLarge'

const LIB_PARSE = `// The one place a log line is understood. Every command uses this; none of
// them parses a line itself. A second regex somewhere else is how the
// definition of "malformed" quietly forks.
export const LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL']
export const LEVEL_SET = new Set(LEVELS)

const LINE = /^(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z) (\\w+) (\\w+) (.*)$/

/**
 * One parsed entry, or null when the line is malformed.
 *
 * Malformed is never an error anywhere in this tool — it is a fact a log has
 * about itself, counted by \`stats\` and skipped by everything else.
 *
 * @returns {{timestamp: string, ms: number, level: string, component: string,
 *   message: string, raw: string} | null}
 */
export function parseLine(line) {
  const match = LINE.exec(line)
  if (!match) return null
  const [, timestamp, level, component, message] = match
  if (!LEVEL_SET.has(level)) return null
  if (component !== component.toLowerCase()) return null
  if (message.length === 0) return null
  return { timestamp, ms: Date.parse(timestamp), level, component, message, raw: line }
}

/** Every well-formed entry, in file order. The usual way in. */
export function parseAll(lines) {
  const entries = []
  for (const line of lines) {
    const entry = parseLine(line)
    if (entry) entries.push(entry)
  }
  return entries
}

/** Well-formed and malformed counts, for the commands that report both. */
export function partition(lines) {
  const entries = parseAll(lines)
  return { entries, skipped: lines.length - entries.length }
}
`

const LIB_RENDER = `// Output shapes. Commands never call JSON.stringify or pad a column
// themselves — the indentation and the column rules live here so every
// command's output looks like every other command's.

/** Every JSON payload in this tool: two-space indent, no trailing newline. */
export function asJson(value) {
  return JSON.stringify(value, null, 2)
}

/** Plain lines, one per element. Empty input is the empty string. */
export function asLines(values) {
  return values.join('\\n')
}

/**
 * A two-column table.
 *
 * The left column is padded to the widest label, then two spaces, then the
 * value. Rows arrive as [label, value] pairs and are printed in the order
 * given — sorting is the caller's decision, not this function's.
 */
export function asTable(rows) {
  if (rows.length === 0) return ''
  const width = Math.max(...rows.map(([label]) => String(label).length))
  return rows.map(([label, value]) => \`\${String(label).padEnd(width)}  \${value}\`).join('\\n')
}

/**
 * A bar of block characters, for the commands that draw one.
 *
 * Scaled against \`max\` over \`width\` cells and rounded up, so any non-zero
 * count draws at least one block — a row that happened must not look like a
 * row that did not.
 */
export function asBar(count, max, width = 20) {
  if (max <= 0 || count <= 0) return ''
  return '\\u2588'.repeat(Math.max(1, Math.ceil((count / max) * width)))
}
`

const LIB_TIME = `// Time bucketing. The labels are part of this tool's output contract, so they
// are defined once here rather than formatted at each call site.

export const STEP_MS = { hour: 3_600_000, minute: 60_000, day: 86_400_000 }

/** Whether a bucket name is one this tool knows. */
export function isBucket(name) {
  return Object.prototype.hasOwnProperty.call(STEP_MS, name)
}

/** The start of the bucket an instant falls in, as epoch milliseconds. */
export function bucketStart(ms, bucket) {
  const step = STEP_MS[bucket]
  return Math.floor(ms / step) * step
}

/**
 * A bucket's label.
 *
 * Day buckets are a date, hour buckets end at the hour, minute buckets keep
 * the minute. All of them end in Z, because everything in this tool is UTC.
 */
export function bucketLabel(ms, bucket) {
  const iso = new Date(ms).toISOString()
  if (bucket === 'day') return iso.slice(0, 10)
  if (bucket === 'hour') return iso.slice(0, 13) + ':00Z'
  return iso.slice(0, 16) + ':00Z'
}

/**
 * Every bucket from first to last inclusive, with no gaps.
 *
 * A quiet hour is a fact about the log, so the series is continuous rather
 * than only the buckets that happen to have entries.
 */
export function bucketSeries(entries, bucket) {
  if (entries.length === 0) return []
  const step = STEP_MS[bucket]
  const counts = new Map()
  for (const entry of entries) {
    const at = bucketStart(entry.ms, bucket)
    counts.set(at, (counts.get(at) ?? 0) + 1)
  }
  const stamps = [...counts.keys()]
  const series = []
  for (let at = Math.min(...stamps); at <= Math.max(...stamps); at += step) {
    series.push({ at, label: bucketLabel(at, bucket), count: counts.get(at) ?? 0 })
  }
  return series
}

/**
 * A duration written the way this tool's flags take it: 30s, 15m, 2h, 1d.
 * Returns null when it is not one of those, which callers report as an error.
 */
export function parseDuration(text) {
  const match = /^(\\d+)([smhd])$/.exec(String(text ?? ''))
  if (!match) return null
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]]
  return Number(match[1]) * unit
}
`

const LIB_ERRORS = `// How a command declines. Every failure in this tool is a message on stderr
// and exit code 2 — there is no third kind, and a command inventing one would
// make the CLI's contract depend on which command you called.

/** A declined command: the message, and the exit code every failure uses. */
export function fail(message) {
  return { stderr: message, code: 2 }
}

/** \`--level\`, normalised, or null when it is not a level this tool knows. */
export function readLevel(options, { required = true } = {}) {
  const given = options.level
  if (given === undefined) return required ? null : undefined
  const upper = String(given).toUpperCase()
  return upper
}

/** A positive integer flag with a default. Returns null when it is not one. */
export function readCount(options, name, fallback) {
  if (options[name] === undefined) return fallback
  const value = Number(options[name])
  if (!Number.isInteger(value) || value < 0) return null
  return value
}
`

const CMD_STATS = `import { partition } from '../lib/parse.js'
import { asJson } from '../lib/render.js'

const sorted = (counts) =>
  Object.fromEntries([...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))

export async function run(lines) {
  const { entries, skipped } = partition(lines)
  const byLevel = new Map()
  const byComponent = new Map()
  for (const entry of entries) {
    byLevel.set(entry.level, (byLevel.get(entry.level) ?? 0) + 1)
    byComponent.set(entry.component, (byComponent.get(entry.component) ?? 0) + 1)
  }
  return {
    stdout: asJson({
      total: entries.length,
      skipped,
      byLevel: sorted(byLevel),
      byComponent: sorted(byComponent)
    }),
    code: 0
  }
}
`

const CMD_FILTER = `import { parseAll, LEVEL_SET } from '../lib/parse.js'
import { asLines } from '../lib/render.js'
import { fail, readLevel } from '../lib/errors.js'

export async function run(lines, options) {
  const level = readLevel(options)
  if (level === null || !LEVEL_SET.has(level)) {
    return fail(\`unknown level: \${options.level ?? ''}\`)
  }
  const matched = parseAll(lines).filter(
    (entry) =>
      entry.level === level && (!options.component || entry.component === options.component)
  )
  return { stdout: asLines(matched.map((entry) => entry.raw)), code: 0 }
}
`

const CMD_TIMELINE = `import { parseAll } from '../lib/parse.js'
import { asJson } from '../lib/render.js'
import { bucketSeries, isBucket } from '../lib/time.js'
import { fail } from '../lib/errors.js'

export async function run(lines, options) {
  const bucket = options.bucket ?? 'hour'
  if (!isBucket(bucket)) return fail(\`unknown bucket: \${bucket}\`)
  const series = bucketSeries(parseAll(lines), bucket)
  return {
    stdout: asJson(series.map(({ label, count }) => ({ bucket: label, count }))),
    code: 0
  }
}
`

const CMD_TOP = `import { parseAll } from '../lib/parse.js'
import { asJson } from '../lib/render.js'
import { fail, readCount } from '../lib/errors.js'

export async function run(lines, options) {
  const n = readCount(options, 'n', 10)
  if (n === null) return fail(\`--n must be a whole number: \${options.n}\`)
  const counts = new Map()
  for (const entry of parseAll(lines)) {
    counts.set(entry.message, (counts.get(entry.message) ?? 0) + 1)
  }
  const ranked = [...counts.entries()]
    .map(([message, count]) => ({ message, count }))
    .sort((a, b) => b.count - a.count || a.message.localeCompare(b.message))
    .slice(0, n)
  return { stdout: asJson(ranked), code: 0 }
}
`

const CLI = `#!/usr/bin/env node
// logtool — see SPEC.md. This file is the interface every command meets; it is
// not part of the work and must not be changed.
import { readFileSync } from 'node:fs'

const COMMANDS = [
  'stats',
  'filter',
  'timeline',
  'top',
  'components',
  'errors',
  'rate',
  'sessions',
  'diff',
  'tail'
]

const [, , command, file, ...rest] = process.argv

if (!command || !COMMANDS.includes(command)) {
  process.stderr.write(\`usage: logtool <\${COMMANDS.join('|')}> <file> [options]\\n\`)
  process.exit(2)
}
if (!file) {
  process.stderr.write('a log file is required\\n')
  process.exit(2)
}

let text
try {
  text = readFileSync(file, 'utf8')
} catch {
  process.stderr.write(\`cannot read \${file}\\n\`)
  process.exit(2)
}

const options = {}
for (const arg of rest) {
  const match = /^--([^=]+)=(.*)$/.exec(arg)
  if (match) options[match[1]] = match[2]
}

const lines = text.split(/\\r?\\n/).filter((line) => line.trim().length > 0)

const { run } = await import(\`./commands/\${command}.js\`)
const result = await run(lines, options)

if (result?.stderr) {
  process.stderr.write(result.stderr.endsWith('\\n') ? result.stderr : result.stderr + '\\n')
}
if (result?.stdout) {
  process.stdout.write(result.stdout.endsWith('\\n') ? result.stdout : result.stdout + '\\n')
}
process.exit(result?.code ?? 0)
`

const SPEC = `# logtool

A command-line tool for reading application log files. Node 20, ES modules,
**no dependencies** — only the Node standard library.

This project already works. Four commands are built, and a shared library sits
under \`lib/\`. **Six more commands are specified in \`SPEC-NEW.md\` and are the
job.** Read what is here first: the new commands are expected to look like the
existing ones and to use the same library, not to reimplement it.

## The log format

    2026-09-20T14:03:11Z ERROR auth Failed login for user 4821

Four fields separated by single spaces: an ISO 8601 UTC timestamp ending in
\`Z\`, a level from \`DEBUG INFO WARN ERROR FATAL\`, a lower-case single-word
component, and a message that runs to the end of the line and may contain
spaces. Anything else is **malformed** — never an error, only skipped and
counted.

## The shared library

**\`lib/parse.js\`** — \`parseLine\`, \`parseAll\`, \`partition\`, \`LEVELS\`,
\`LEVEL_SET\`. One definition of a log line for the whole tool. **No command
parses a line itself**; a second regex elsewhere is how "malformed" forks.

**\`lib/render.js\`** — \`asJson\` (two-space indent), \`asLines\`, \`asTable\`
(left column padded to the widest label, two spaces, then the value), \`asBar\`
(block characters scaled against a maximum, rounding up so any non-zero count
draws at least one block).

**\`lib/time.js\`** — \`STEP_MS\`, \`isBucket\`, \`bucketStart\`, \`bucketLabel\`,
\`bucketSeries\` (a continuous series from first to last, including empty
buckets), \`parseDuration\` (\`30s\`, \`15m\`, \`2h\`, \`1d\`, else null).

**\`lib/errors.js\`** — \`fail(message)\` returns the one failure shape this tool
has: that message on stderr, exit code 2. Also \`readLevel\` and \`readCount\`.

## The command interface

\`cli.js\` is written and **must not be changed**. It reads the file, splits it
into non-blank lines, parses \`--key=value\` flags into an object, imports
\`commands/<name>.js\` and calls:

    export async function run(lines, options) { ... }

Return \`{ stdout, code }\` to print to standard output, or \`{ stderr, code }\`
to print to standard error. \`cli.js\` adds the trailing newline.

## The four that exist

\`stats\`, \`filter\`, \`timeline\` and \`top\` are built and working. Read them —
they are the worked examples of every convention above.

## Definition of done

The six commands in \`SPEC-NEW.md\` work as specified, each using the shared
library rather than its own parsing, formatting or time handling.
`

const SPEC_NEW = `# The six commands to build

Each one is \`commands/<name>.js\`, exporting \`run(lines, options)\` and using
the shared library in \`lib/\`. See \`SPEC.md\` for the conventions and the
existing commands for worked examples.

Every failure is \`fail(message)\` from \`lib/errors.js\` — that message on
stderr, exit code 2. There is no other failure shape.

---

## \`components\`

A breakdown per component, with its levels nested inside. JSON, exit 0:

\`\`\`json
{
  "api": { "total": 2, "byLevel": { "INFO": 2 } },
  "auth": { "total": 2, "byLevel": { "ERROR": 1, "WARN": 1 } }
}
\`\`\`

- Components sorted alphabetically; levels within each sorted alphabetically.
- Only levels that appear. No zeroes.
- \`--min=2\` drops components with fewer than that many entries. Default 1.
- An empty log prints \`{}\`.

## \`errors\`

Every \`ERROR\` and \`FATAL\` line, with the lines around it for context.

- \`--context=2\` — how many well-formed entries before and after each one.
  Default 0. Must be a whole number, else fail.
- Output is raw lines, in file order. A context line that is also an error is
  printed once, not twice.
- Between two non-adjacent groups print a line containing exactly \`--\`.
  Groups that overlap or touch are merged rather than separated.
- No errors is exit 0 and no output.

## \`rate\`

Entries per bucket, as a table with a bar. Exit 0:

\`\`\`
2026-09-20T14:00Z  4  ████████████████████
2026-09-20T15:00Z  0
2026-09-20T16:00Z  4  ████████████████████
\`\`\`

- Built with \`asTable\` from \`lib/render.js\`, so the label column is padded to
  the widest label. The value column is the count, two spaces, then the bar
  from \`asBar\` scaled against the busiest bucket. A zero bucket has no bar and
  no trailing spaces after the count.
- \`--bucket=hour|minute|day\`, default \`hour\`. Unknown buckets fail.
- The series is continuous — use \`bucketSeries\`.
- An empty log prints nothing, exit 0.

## \`sessions\`

Group entries into sessions, split wherever the gap between consecutive
entries is at least the threshold. JSON, exit 0:

\`\`\`json
[
  { "start": "2026-09-20T14:03:11Z", "end": "2026-09-20T14:58:00Z", "entries": 4 }
]
\`\`\`

- \`--gap=30m\` — the threshold, as \`lib/time.js\`'s \`parseDuration\` takes it.
  Default \`30m\`. Anything it rejects fails with \`unknown duration: <what>\`.
- Sessions in time order. A single entry is a session whose start and end are
  the same instant.
- An empty log prints \`[]\`.

## \`diff\`

Compare this log against another. \`--against=<path>\` is required; a file that
cannot be read fails with \`cannot read <path>\`. JSON, exit 0:

\`\`\`json
{
  "total": { "before": 8, "after": 5, "change": -3 },
  "byLevel": { "ERROR": { "before": 2, "after": 0, "change": -2 } }
}
\`\`\`

- \`before\` is the file given to the command, \`after\` is \`--against\`.
- \`byLevel\` covers every level appearing in either file, sorted
  alphabetically, with zero for a level missing from one side.
- Exit code is 0 whether or not anything differs. This reports, it does not
  judge.

## \`tail\`

The last entries, newest first. Raw lines, exit 0.

- \`--n=5\` — how many. Default 10, and \`--n=0\` prints nothing.
- \`--level=ERROR\` — optional, filters before taking the last n. An unknown
  level fails the same way \`filter\` does.
- Newest first, which is the reverse of file order.
`

const PACKAGE = JSON.stringify(
  { name: 'logtool', version: '2.0.0', type: 'module', private: true },
  null,
  2
)

/**
 * A longer sample, because several of the new commands are about structure
 * over time — session gaps, context windows, a continuous rate series — and a
 * nine-line log cannot exercise any of them.
 */
const SAMPLE = [
  '2026-09-20T09:00:00Z INFO boot Service starting',
  '2026-09-20T09:00:04Z INFO boot Loaded 12 routes',
  '2026-09-20T09:01:10Z DEBUG db Pool opened',
  '2026-09-20T09:02:00Z INFO api Request served',
  '2026-09-20T09:02:30Z WARN api Slow response',
  '2026-09-20T09:03:00Z ERROR db Connection reset',
  '2026-09-20T09:03:20Z INFO db Reconnected',
  'this line is not a log line at all',
  '2026-09-20T11:30:00Z INFO api Request served',
  '2026-09-20T11:30:40Z ERROR auth Failed login for user 4821',
  '2026-09-20T11:31:00Z ERROR auth Failed login for user 4821',
  '2026-09-20T11:31:30Z INFO auth Login succeeded',
  '2026-09-20T13:00:00Z FATAL db Disk full',
  '2026-09-20T13:00:10Z INFO boot Shutting down',
  '   ',
  '2026-09-20T13:00:20Z DEBUG boot Flushed buffers'
].join('\n')

/** A second, smaller log for `diff` to compare against. */
const OTHER = [
  '2026-09-20T09:00:00Z INFO boot Service starting',
  '2026-09-20T09:02:00Z INFO api Request served',
  '2026-09-20T09:03:20Z INFO db Reconnected',
  '2026-09-20T11:31:30Z WARN auth Login succeeded',
  '2026-09-20T13:00:10Z INFO boot Shutting down'
].join('\n')

export function writeWorkspace(root = WORKSPACE) {
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true })
  fs.mkdirSync(path.join(root, 'commands'), { recursive: true })
  fs.mkdirSync(path.join(root, 'samples'), { recursive: true })

  fs.writeFileSync(path.join(root, 'SPEC.md'), SPEC, 'utf8')
  fs.writeFileSync(path.join(root, 'SPEC-NEW.md'), SPEC_NEW, 'utf8')
  fs.writeFileSync(path.join(root, 'cli.js'), CLI, 'utf8')
  fs.writeFileSync(path.join(root, 'package.json'), PACKAGE + '\n', 'utf8')

  fs.writeFileSync(path.join(root, 'lib', 'parse.js'), LIB_PARSE, 'utf8')
  fs.writeFileSync(path.join(root, 'lib', 'render.js'), LIB_RENDER, 'utf8')
  fs.writeFileSync(path.join(root, 'lib', 'time.js'), LIB_TIME, 'utf8')
  fs.writeFileSync(path.join(root, 'lib', 'errors.js'), LIB_ERRORS, 'utf8')

  fs.writeFileSync(path.join(root, 'commands', 'stats.js'), CMD_STATS, 'utf8')
  fs.writeFileSync(path.join(root, 'commands', 'filter.js'), CMD_FILTER, 'utf8')
  fs.writeFileSync(path.join(root, 'commands', 'timeline.js'), CMD_TIMELINE, 'utf8')
  fs.writeFileSync(path.join(root, 'commands', 'top.js'), CMD_TOP, 'utf8')

  fs.writeFileSync(path.join(root, 'samples', 'app.log'), SAMPLE + '\n', 'utf8')
  fs.writeFileSync(path.join(root, 'samples', 'other.log'), OTHER + '\n', 'utf8')
  return root
}

if (process.argv[1] && process.argv[1].endsWith('bench-build-large-fixture.mjs')) {
  const root = writeWorkspace()
  let lines = 0
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name)
      if (fs.statSync(full).isDirectory()) walk(full)
      else lines += fs.readFileSync(full, 'utf8').split('\n').length
    }
  }
  walk(root)
  console.log(`wrote ${root} — ${lines} lines to read before anything can be written`)
}
