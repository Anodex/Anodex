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

const ARMS = [
  { name: 'off', subAgentsEnabled: false, goal: BASE },
  { name: '1', subAgentsEnabled: true, goal: BASE + splitInstruction(1) },
  { name: '2', subAgentsEnabled: true, goal: BASE + splitInstruction(2) },
  { name: '3', subAgentsEnabled: true, goal: BASE + splitInstruction(3) }
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
      'grep_files',
      'find_files'
    ],
    provider: 'local',
    maxTurns: 24,
    maxTokens: 300000,
    maxDurationMinutes: 45,
    // No plan review: it spends turns from the same budget and adds a phase
    // that has nothing to do with what is being measured.
    requirePlan: false,
    subAgentsEnabled: arm.subAgentsEnabled
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
