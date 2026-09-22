// Generate the four arm specs for the sub-agent A/B sweep.
//
// Forward slashes in the project path, deliberately. Windows accepts them
// everywhere Anodex uses them, and a backslash has to survive this file, the
// JSON encoder and whatever shell invoked it — it did not: the first sweep
// wrote "C:UsersOwnerDesktopSandboxBugHunt" and failed every arm identically,
// because `\U` is not a valid escape and the backslash was dropped before
// JSON.stringify ever saw it.
//
// Usage: node scripts/bench-subagents-specs.mjs
import fs from 'node:fs'

const PROJECT_PATH = 'C:/Users/Owner/Desktop/Sandbox/BugHunt'

/**
 * The same instruction for every arm.
 *
 * Read-only on purpose: this is a review, and a run that could edit might
 * quietly "fix" a bug and then not report it, which the scorer would count as
 * a miss. It also keeps the corpus identical between runs with no reset step
 * that could be forgotten.
 */
const BASE = [
  'The project folder is a small Python service with a number of real bugs in it. ' +
    'Read the code and find them.',
  '',
  'Look at every module, including the ones that turn out to be fine. For each bug, report ' +
    'the file, the function, and what is actually wrong with it — enough that someone could ' +
    'fix it without rediscovering it. Do not fix anything; this is a review, not a repair.',
  '',
  'When you are done, call finish_goal with the complete list of bugs you found.'
].join('\n')

/**
 * The only difference between arms.
 *
 * The count is asked for rather than enforced, because nothing in the product
 * caps it per run and adding a knob only a benchmark uses would be a worse
 * trade than measuring what actually happened. The report reads the real
 * child count off each run, so an arm that did not comply is visible as
 * itself rather than counted as the arm it was meant to be.
 */
const splitInstruction = (n) =>
  '\n\nSplit this work across exactly ' +
  ['', 'one', 'two', 'three'][n] +
  ` sub-agent${n === 1 ? '' : 's'} using the delegate tool, giving each one a different set of ` +
  'modules to read, then collate what they report.'

/**
 * The arms.
 *
 * `--ctx-size` is the total window and the engine divides it between
 * parallel slots, so `parallelJobs` decides how much context *every* agent
 * gets, solo or not. Two baselines therefore:
 *
 * - `off` runs with one job and the whole 65,536, which is the best a single
 *   agent can do on this machine and the number to beat.
 * - `off-split` runs with three jobs and so about 21,845, which is what a
 *   solo run actually gets once you turn concurrency on. Without it, any win
 *   for sub-agents could just be the baseline being handicapped, and any
 *   loss could be hidden by the baseline being privileged.
 *
 * `3` is included knowing it cannot run: the parent holds one of three slots,
 * so two sub-agents is the local ceiling and a third is refused. Worth
 * measuring that it refuses quickly rather than hanging.
 */
/**
 * The taxonomy a parent writes for its sub-agents, folded into a solo goal.
 *
 * The per-bug table says the whole recall advantage of delegating is one
 * bug, `retry-counter`, which no solo run has ever found and two sub-agents
 * find every time. The parents' briefs name the category outright —
 * "infinite loops, off-by-one on attempt counts" — where the user's goal
 * only says "find the bugs".
 *
 * So the advantage may not be parallelism or context division at all, but
 * the parent writing a better prompt than the user did. This arm tests that
 * directly: if a solo run given the same enumeration finds the same bug, the
 * fan-out was an expensive way of getting the model to brief itself, and the
 * same result is available at a third of the cost.
 */
const TAXONOMY =
  '\n\nLook specifically for: off-by-one errors, wrong comparison operators, inverted ' +
  'boolean conditions, incorrect arithmetic, wrong units (milliseconds versus seconds), ' +
  'float-versus-integer money handling, broken edge cases (empty input, zero, negatives), ' +
  'cache eviction and recency mistakes, unanchored or over-permissive validation, broken ' +
  'retry semantics (wrong delay growth, infinite loops, off-by-one on attempt counts), and ' +
  'token or password checks that accept what they should reject. For each bug give the ' +
  'file, the function, the offending line, and a concrete input that triggers it. Report ' +
  'only real defects, not style.'

const ARMS = [
  { name: 'off', subAgentsEnabled: false, parallelJobs: 1, goal: BASE },
  { name: 'off-split', subAgentsEnabled: false, parallelJobs: 3, goal: BASE },
  { name: '1', subAgentsEnabled: true, parallelJobs: 3, goal: BASE + splitInstruction(1) },
  { name: '2', subAgentsEnabled: true, parallelJobs: 3, goal: BASE + splitInstruction(2) },
  { name: '3', subAgentsEnabled: true, parallelJobs: 3, goal: BASE + splitInstruction(3) },
  { name: 'off-brief', subAgentsEnabled: false, parallelJobs: 1, goal: BASE + TAXONOMY },
  // Children on a cloud provider, parent local. The gate only serialises
  // local generation, so these are the first arms where the sub-agents
  // genuinely run at the same time rather than queueing behind the parent.
  // parallelJobs stays at 1: nothing here needs a second local slot, and
  // raising it would divide the parent's window for no reason.
  {
    name: 'cloud-1',
    subAgentsEnabled: true,
    parallelJobs: 1,
    childProviders: ['deepseek'],
    goal: BASE + splitInstruction(1)
  },
  {
    name: 'cloud-2',
    subAgentsEnabled: true,
    parallelJobs: 1,
    childProviders: ['deepseek', 'deepseek'],
    goal: BASE + splitInstruction(2)
  },
  {
    name: 'cloud-3',
    subAgentsEnabled: true,
    parallelJobs: 1,
    childProviders: ['deepseek', 'deepseek', 'deepseek'],
    goal: BASE + splitInstruction(3)
  },
  // The mirror image: a cloud parent directing local children.
  //
  // Interesting because the two halves have opposite economics. The parent
  // coordinates, which the decomposition says is 73-85% of the wall clock
  // and is pure latency — cheap and fast on a hosted model. The children
  // read a lot of code, which is where tokens are spent, and doing that on
  // hardware you already own costs nothing per token.
  //
  // parallelJobs is 3 because a cloud parent holds no local slot, so three
  // local children genuinely run at once rather than queueing.
  {
    name: 'flip-1',
    provider: 'deepseek',
    subAgentsEnabled: true,
    parallelJobs: 3,
    childProviders: ['local'],
    goal: BASE + splitInstruction(1)
  },
  {
    name: 'flip-2',
    provider: 'deepseek',
    subAgentsEnabled: true,
    parallelJobs: 3,
    childProviders: ['local', 'local'],
    goal: BASE + splitInstruction(2)
  },
  // The fourth quadrant: everything hosted. Completes the 2x2 of where the
  // parent runs against where the children run, so the comparison is a
  // matrix rather than three points and a gap.
  {
    name: 'both-cloud-1',
    provider: 'deepseek',
    subAgentsEnabled: true,
    parallelJobs: 1,
    childProviders: ['deepseek'],
    goal: BASE + splitInstruction(1)
  },
  {
    name: 'flip-3',
    provider: 'deepseek',
    subAgentsEnabled: true,
    parallelJobs: 3,
    childProviders: ['local', 'local', 'local'],
    goal: BASE + splitInstruction(3)
  }
]

for (const arm of ARMS) {
  const spec = {
    goal: arm.goal,
    project: 'BugHunt',
    projectPath: PROJECT_PATH,
    enabledTools: [
      'list_directory',
      'read_file',
      'read_file_range',
      'read_multiple_files',
      'search_files',
      'find_files'
    ],
    provider: arm.provider ?? 'local',
    maxTurns: 24,
    maxTokens: 300000,
    maxDurationMinutes: 45,
    // No plan review: it spends turns from the same budget and adds a phase
    // that has nothing to do with what is being measured.
    requirePlan: false,
    subAgentsEnabled: arm.subAgentsEnabled,
    ...(arm.childProviders ? { subAgentProviders: arm.childProviders } : {}),
    contextSize: 65536,
    parallelJobs: arm.parallelJobs
  }
  const file = `scripts/bench-subagents-${arm.name}.json`
  fs.writeFileSync(file, JSON.stringify(spec, null, 2) + '\n')
  console.log(`wrote ${file}  (subAgents=${arm.subAgentsEnabled})`)
}

// Prove the path survived, rather than trusting that it did — this is the
// exact failure this file exists to prevent.
const written = JSON.parse(fs.readFileSync('scripts/bench-subagents-off.json', 'utf8'))
if (!fs.existsSync(written.projectPath)) {
  throw new Error(`projectPath did not survive encoding: ${written.projectPath}`)
}
console.log(`projectPath verified on disk: ${written.projectPath}`)
