// Lay down the starting workspace for the build benchmark, and hold the
// acceptance suite that grades what came out of it.
//
// The bug-hunt sweep could be read-only, so it needed no reset and every arm
// saw an identical corpus for free. A build sweep mutates, so the workspace is
// rebuilt from here before every run — and the finished copy is archived
// before the next one wipes it.
//
// Usage:
//   node scripts/bench-build-fixture.mjs           # write the workspace
//   node scripts/bench-build-fixture.mjs --tests   # print the acceptance list
import fs from 'node:fs'
import path from 'node:path'

export const WORKSPACE = 'C:/Users/Owner/Desktop/Sandbox/BuildTool'

/**
 * The spec the run is asked to implement.
 *
 * Written to be genuinely divisible: four subcommands that share a log format
 * and nothing else. That is the precondition for delegation to have anything
 * to do — and it is also the thing the bug hunt could not test, because
 * reading a codebase divides trivially and *building* one does not.
 *
 * The dispatcher is supplied rather than asked for. A real team agrees the
 * interface before splitting the work, and without it the four parts would be
 * four guesses at a filename: every delegating arm would fail for a reason
 * that is about the harness rather than about delegation.
 */
const SPEC = `# logtool

A command-line tool for reading application log files. Node 20, ES modules,
**no dependencies** — only the Node standard library.

## The log format

Every line of a log file looks like this:

    2026-09-20T14:03:11Z ERROR auth Failed login for user 4821

Four fields, separated by single spaces:

| field | meaning |
| --- | --- |
| timestamp | ISO 8601, always UTC, always ends in \`Z\` |
| level | one of \`DEBUG\` \`INFO\` \`WARN\` \`ERROR\` \`FATAL\` |
| component | a single word, lower case |
| message | everything after the component; may contain spaces |

A line that does not match this shape is **malformed**. Malformed lines are
never an error — they are skipped, and \`stats\` counts them.

## What already exists

\`cli.js\` is written and must not be changed. It parses \`process.argv\`,
requires a subcommand and a file path, and dispatches:

    node cli.js <command> <file> [options]

It imports each command from its own module in \`commands/\` and calls the
exported \`run\` function. Those four modules do not exist yet. **Writing them
is the job.**

Each module exports:

    export async function run(lines, options) { ... }

- \`lines\` — the file's contents split into lines, with blank lines removed.
  \`cli.js\` has already read the file and handled a missing one.
- \`options\` — the parsed \`--key=value\` flags as a plain object of strings.
- Return \`{ stdout, code }\`. \`cli.js\` prints \`stdout\` and exits with \`code\`.
  Return \`{ stderr, code }\` instead to print to standard error.

## The four commands

### \`commands/stats.js\`

Counts. Prints JSON, two-space indented, exit code 0:

\`\`\`json
{
  "total": 12,
  "skipped": 1,
  "byLevel": { "ERROR": 3, "INFO": 9 },
  "byComponent": { "auth": 5, "db": 7 }
}
\`\`\`

- \`total\` counts well-formed lines only.
- \`skipped\` counts malformed ones.
- \`byLevel\` and \`byComponent\` list only what actually appears. A level with
  no entries must not appear with a zero.
- Keys in both objects are sorted alphabetically.

### \`commands/filter.js\`

Prints the matching lines **verbatim**, one per line, in the order they appear.

- \`--level=ERROR\` — required. Case-insensitive on input; an unknown level is
  an error: print \`unknown level: <what was given>\` to stderr, exit code 2.
- \`--component=auth\` — optional, narrows further. Exact match, case-sensitive.
- No matches is not an error: print nothing, exit code 0.

### \`commands/timeline.js\`

Counts entries per time bucket. Prints a JSON array, two-space indented, exit 0:

\`\`\`json
[
  { "bucket": "2026-09-20T14:00Z", "count": 4 },
  { "bucket": "2026-09-20T15:00Z", "count": 0 },
  { "bucket": "2026-09-20T16:00Z", "count": 2 }
]
\`\`\`

- \`--bucket=hour\` or \`--bucket=minute\`. Anything else: \`unknown bucket: <x>\`
  to stderr, exit 2. Missing \`--bucket\` means \`hour\`.
- Buckets are labelled by their start: hour buckets end \`:00Z\`, minute
  buckets end \`:00Z\` with the minute kept, e.g. \`2026-09-20T14:03:00Z\`.
- **Every bucket between the first and last entry appears, including empty
  ones.** A quiet hour is a fact about the log.
- Malformed lines are skipped and do not create buckets.
- An empty log prints \`[]\`.

### \`commands/top.js\`

The most frequent messages. Prints a JSON array, two-space indented, exit 0:

\`\`\`json
[
  { "message": "Connection reset", "count": 9 },
  { "message": "Failed login for user 4821", "count": 4 }
]
\`\`\`

- \`--n=5\` — how many to print. Missing means 10. \`--n=0\` prints \`[]\`.
- Messages are compared exactly, including case and punctuation.
- Most frequent first. **Ties are broken alphabetically by message**, so the
  output is the same every run.
- Fewer distinct messages than \`n\` simply prints fewer.

## Definition of done

\`node cli.js stats samples/app.log\` and the other three commands run and
produce exactly the shapes above. Nothing imports anything outside the
standard library.
`

/** The dispatcher. Supplied, so the four parts have an interface to meet. */
const CLI = `#!/usr/bin/env node
// logtool — see SPEC.md. This file is the interface the commands meet; it is
// not part of the work and must not be changed.
import { readFileSync } from 'node:fs'

const COMMANDS = ['stats', 'filter', 'timeline', 'top']

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

if (result?.stderr) process.stderr.write(result.stderr.endsWith('\\n') ? result.stderr : result.stderr + '\\n')
if (result?.stdout) process.stdout.write(result.stdout.endsWith('\\n') ? result.stdout : result.stdout + '\\n')
process.exit(result?.code ?? 0)
`

const PACKAGE = JSON.stringify(
  { name: 'logtool', version: '1.0.0', type: 'module', private: true },
  null,
  2
)

/**
 * The sample log the spec points at.
 *
 * Deliberately contains the cases the spec calls out and a careless
 * implementation drops: a malformed line, an empty hour in the middle, a tie
 * in message frequency, and a message with spaces in it.
 */
const SAMPLE = [
  '2026-09-20T14:03:11Z ERROR auth Failed login for user 4821',
  '2026-09-20T14:05:02Z INFO db Connection reset',
  '2026-09-20T14:31:44Z INFO db Connection reset',
  '2026-09-20T14:58:00Z WARN auth Slow response',
  'this line is not a log line at all',
  '2026-09-20T16:01:09Z ERROR db Connection reset',
  '2026-09-20T16:02:10Z INFO api Request served',
  '2026-09-20T16:02:59Z INFO api Request served',
  '2026-09-20T16:40:00Z FATAL db Disk full'
].join('\n')

export function writeWorkspace(root = WORKSPACE) {
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(path.join(root, 'samples'), { recursive: true })
  fs.mkdirSync(path.join(root, 'commands'), { recursive: true })
  fs.writeFileSync(path.join(root, 'SPEC.md'), SPEC, 'utf8')
  fs.writeFileSync(path.join(root, 'cli.js'), CLI, 'utf8')
  fs.writeFileSync(path.join(root, 'package.json'), PACKAGE + '\n', 'utf8')
  fs.writeFileSync(path.join(root, 'samples', 'app.log'), SAMPLE + '\n', 'utf8')
  // An empty directory does not survive a copy on every tool, and the spec
  // says the four modules do not exist yet — so leave a note rather than
  // nothing, and make it unmistakably not an implementation.
  fs.writeFileSync(
    path.join(root, 'commands', 'README.md'),
    'The four command modules go here: stats.js, filter.js, timeline.js, top.js.\nSee ../SPEC.md.\n',
    'utf8'
  )
  return root
}

if (process.argv[1] && process.argv[1].endsWith('bench-build-fixture.mjs')) {
  if (process.argv.includes('--tests')) {
    const { ACCEPTANCE } = await import('./bench-build-accept.mjs')
    for (const check of ACCEPTANCE) console.log(`${check.command.padEnd(10)} ${check.name}`)
    console.log(`\n${ACCEPTANCE.length} acceptance checks`)
  } else {
    console.log('wrote', writeWorkspace())
  }
}
