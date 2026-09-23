// Generate the arm specs for the build A/B sweep.
//
// Forward slashes in the project path, deliberately — see the note in
// `bench-subagents-specs.mjs`; a backslash did not survive this file, the JSON
// encoder and the shell, and a whole sweep failed identically because of it.
//
// Usage: node scripts/bench-build-specs.mjs
import fs from 'node:fs'
import { WORKSPACE } from './bench-build-fixture.mjs'

/**
 * The same instruction for every arm.
 *
 * It names the spec file rather than restating it. A goal that contained the
 * whole specification would hand every arm the same 1,500-token head start and
 * measure reading comprehension of the prompt instead of the work — and the
 * bug hunt already showed that what the *goal* says is the single biggest
 * lever on the result, which is exactly the variable to hold still here.
 */
const BASE = [
  'The project folder holds SPEC.md, a working cli.js and a samples/ directory. ' +
    'Read SPEC.md and build what it describes: the four command modules in commands/.',
  '',
  'cli.js is already written and must not be changed — it is the interface your ' +
    'modules have to meet. Each module exports an async `run(lines, options)` and ' +
    'returns `{ stdout, code }` or `{ stderr, code }`, exactly as the spec says.',
  '',
  'Use only the Node standard library. Check your work by running the commands ' +
    'against samples/app.log before you finish.',
  '',
  'When every command in the spec works, call finish_goal with a short account of ' +
    'what you built and anything you could not get working.'
].join('\n')

/**
 * The only difference between the delegating arms.
 *
 * Asked for rather than enforced, same as the bug-hunt sweep: nothing in the
 * product caps children per run, and the report reads the real count off each
 * run so an arm that did not comply shows up as itself.
 */
const splitInstruction = (n) =>
  '\n\nSplit this work across exactly ' +
  ['', 'one', 'two'][n] +
  ` sub-agent${n === 1 ? '' : 's'} using the delegate tool, giving each one a different ` +
  'set of commands to build, and build the rest yourself. Make sure what they build ' +
  'fits together with what you build.'

/**
 * Tools. Write tools are the point — this arm writes code — and `run_command`
 * is included because "check your work by running it" is not a request a run
 * can honour without it, and a build benchmark that cannot tell whether the
 * thing runs is measuring the wrong thing.
 */
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
 * Budgets.
 *
 * Larger than the bug hunt's, because writing five modules and running them is
 * more turns than reading eight files — and because `splitRunBudget` divides
 * what is left among the children, so a parent that delegates late needs the
 * headroom to still have something to give.
 */
const BUDGET = { maxTurns: 40, maxTokens: 500_000, maxDurationMinutes: 75 }

const base = (extra) => ({
  goal: BASE + (extra ?? ''),
  project: 'BuildTool',
  projectPath: WORKSPACE,
  enabledTools: TOOLS,
  provider: 'local',
  ...BUDGET,
  requirePlan: false,
  contextSize: 65_536
})

/**
 * The arms.
 *
 * Two baselines, not one. `--ctx-size` is the *total* and the engine divides
 * it between slots, so a solo run at three jobs gets about 21,845 tokens of
 * window and a solo run at one job gets the whole 65,536. Comparing the
 * delegating arms only against the second would credit delegation for a
 * handicap it does not have; comparing only against the first would hide the
 * price the delegating arms pay for their slots. Both, then.
 */
const ARMS = {
  'off-1job': base(),
  'off-3jobs': base(),
  'sub-1': base(splitInstruction(1)),
  'sub-2': base(splitInstruction(2))
}

ARMS['off-1job'].parallelJobs = 1
ARMS['off-1job'].subAgentsEnabled = false

ARMS['off-3jobs'].parallelJobs = 3
ARMS['off-3jobs'].subAgentsEnabled = false

ARMS['sub-1'].parallelJobs = 3
ARMS['sub-1'].subAgentsEnabled = true
ARMS['sub-1'].subAgentProviders = []

ARMS['sub-2'].parallelJobs = 3
ARMS['sub-2'].subAgentsEnabled = true
ARMS['sub-2'].subAgentProviders = []

for (const [name, spec] of Object.entries(ARMS)) {
  const file = `scripts/bench-build-${name}.json`
  fs.writeFileSync(file, JSON.stringify(spec, null, 2) + '\n', 'utf8')
  console.log(
    `${file.padEnd(38)} jobs=${spec.parallelJobs} ` +
      `window≈${Math.floor(spec.contextSize / spec.parallelJobs).toLocaleString()} ` +
      `subagents=${spec.subAgentsEnabled}`
  )
}

if (!fs.existsSync(WORKSPACE)) {
  console.log(`\nWorkspace missing. Run: node scripts/bench-build-fixture.mjs`)
}
