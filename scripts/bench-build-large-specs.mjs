// Generate the arm specs for the larger build A/B.
//
// Same four arms as the small workload and for the same reason — two
// baselines, because `--ctx-size` is the total and the engine divides it
// between slots. What changes is the work: six commands to add to a project
// that already exists, whose library and conventions have to be read before
// anything can be written.
//
// Usage: node scripts/bench-build-large-specs.mjs
import fs from 'node:fs'
import { WORKSPACE } from './bench-build-large-fixture.mjs'

const BASE = [
  'The project folder is a working command-line tool. Read SPEC.md first — it ' +
    'describes the shared library in lib/ and the four commands already built on top ' +
    'of it. Then read SPEC-NEW.md, which specifies six more commands to add: ' +
    'components, errors, rate, sessions, diff and tail.',
  '',
  'Build those six as commands/<name>.js. Use the existing library rather than your ' +
    'own parsing, formatting or time handling — the four commands that already exist ' +
    'are the worked examples. Do not change cli.js, anything in lib/, or the four ' +
    'commands that already work.',
  '',
  'Check your work by running the commands against samples/app.log before you finish.',
  '',
  'When the six commands work, call finish_goal with a short account of what you built ' +
    'and anything you could not get working.'
].join('\n')

const splitInstruction = (n) =>
  '\n\nSplit this work across exactly ' +
  ['', 'one', 'two'][n] +
  ` sub-agent${n === 1 ? '' : 's'} using the delegate tool, giving each one a different ` +
  'set of commands to build, and build the rest yourself. Each sub-agent starts with no ' +
  'knowledge of this conversation, so tell it what it needs to know about the library it ' +
  'must use. Make sure what they build fits together with what you build.'

const TOOLS = [
  'list_directory',
  'read_file',
  'read_file_range',
  'read_multiple_files',
  'search_files',
  'find_files',
  'write_file',
  'edit_file',
  'create_directory',
  'run_command'
]

/**
 * Bigger than the small workload's, because reading 489 lines of existing code
 * is now part of the job before a line can be written — and because the point
 * of this workload is to find the size where a small window struggles, which
 * is not a thing to discover by running out of turns instead.
 */
const BUDGET = { maxTurns: 50, maxTokens: 700_000, maxDurationMinutes: 100 }

const base = (extra) => ({
  goal: BASE + (extra ?? ''),
  project: 'BuildToolLarge',
  projectPath: WORKSPACE,
  enabledTools: TOOLS,
  provider: 'local',
  ...BUDGET,
  requirePlan: false,
  contextSize: 65_536
})

const ARMS = {
  'large-off-1job': base(),
  'large-off-3jobs': base(),
  'large-sub-1': base(splitInstruction(1)),
  'large-sub-2': base(splitInstruction(2))
}

ARMS['large-off-1job'].parallelJobs = 1
ARMS['large-off-1job'].subAgentsEnabled = false

ARMS['large-off-3jobs'].parallelJobs = 3
ARMS['large-off-3jobs'].subAgentsEnabled = false

ARMS['large-sub-1'].parallelJobs = 3
ARMS['large-sub-1'].subAgentsEnabled = true
ARMS['large-sub-1'].subAgentProviders = []

ARMS['large-sub-2'].parallelJobs = 3
ARMS['large-sub-2'].subAgentsEnabled = true
ARMS['large-sub-2'].subAgentProviders = []

for (const [name, spec] of Object.entries(ARMS)) {
  const file = `scripts/bench-build-${name}.json`
  fs.writeFileSync(file, JSON.stringify(spec, null, 2) + '\n', 'utf8')
  console.log(
    `${file.padEnd(44)} jobs=${spec.parallelJobs} ` +
      `window≈${Math.floor(spec.contextSize / spec.parallelJobs).toLocaleString()} ` +
      `subagents=${spec.subAgentsEnabled}`
  )
}
