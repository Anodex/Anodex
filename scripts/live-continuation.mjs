// Watch a scheduled continuation do real work, on the real model.
//
// The end-to-end tests prove the wiring in an app with no model loaded: the
// schedule fires, a run starts, and that run then fails for want of an engine.
// What they cannot show is the thing the feature is actually for — that run
// two picks up where run one left off instead of doing it again.
//
// So the workload is a checklist. Each run is told to do exactly one unchecked
// item and tick it off. If continuity works, run two does the second item. If
// the journal is not reaching it, run two redoes the first — which is the
// failure this whole feature exists to prevent, and it is visible in a
// directory listing.
//
// Usage:
//   node scripts/live-continuation.mjs setup     # workspace + run 1 spec
//   node scripts/live-continuation.mjs schedule  # arm the continuation
//   node scripts/live-continuation.mjs check     # what happened
//   node scripts/live-continuation.mjs cleanup   # put the machine back
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const WORKSPACE = 'C:/Users/Owner/Desktop/Sandbox/KeepGoing'
const USER_DATA = path.join(os.homedir(), 'AppData', 'Roaming', 'anodex')
const RUNS = path.join(USER_DATA, 'agent-runs', 'runs.json')
const TASKS = path.join(USER_DATA, 'scheduled-tasks', 'tasks.json')
const SPEC = 'scripts/live-continuation-run1.json'
const TASK_ID = 'live_continuation_probe'

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

const GOAL = [
  'The project folder holds TASKS.md, a checklist.',
  '',
  'Do exactly ONE unchecked item — the first one — and nothing else. Then tick its box ' +
    'in TASKS.md by changing "- [ ]" to "- [x]" on that line only.',
  '',
  'Do not do more than one item, even if the rest look easy. Do not tick a box whose work ' +
    'you did not do.',
  '',
  'When that one item is done and ticked, call finish_goal saying which item you did.'
].join('\n')

const TASKS_MD = `# Tasks

Do one per run, in order, ticking each off as you go.

- [ ] Create a file called one.txt containing exactly the word: one
- [ ] Create a file called two.txt containing exactly the word: two
- [ ] Create a file called three.txt containing exactly the word: three
`

function setup() {
  fs.rmSync(WORKSPACE, { recursive: true, force: true })
  fs.mkdirSync(WORKSPACE, { recursive: true })
  fs.writeFileSync(path.join(WORKSPACE, 'TASKS.md'), TASKS_MD, 'utf8')

  fs.writeFileSync(
    SPEC,
    JSON.stringify(
      {
        goal: GOAL,
        project: 'KeepGoing',
        projectPath: WORKSPACE,
        enabledTools: ['list_directory', 'read_file', 'write_file', 'edit_file'],
        provider: 'local',
        maxTurns: 12,
        maxTokens: 200_000,
        maxDurationMinutes: 30,
        requirePlan: false
      },
      null,
      2
    ) + '\n'
  )
  console.log(`workspace at ${WORKSPACE}`)
  console.log(`run 1 spec at ${SPEC}`)
  console.log('\nStart it with:')
  console.log(`  ANODEX_AGENT_AUTORUN=${SPEC} npm run dev`)
}

/** The series to continue: the newest top-level run against this workspace. */
function seriesId() {
  const runs = readJson(RUNS, []) ?? []
  const mine = runs.filter((run) => !run.parentRunId && run.goal?.includes('TASKS.md, a checklist'))
  if (mine.length === 0) return null
  const newest = mine.reduce((a, b) => (a.createdAt > b.createdAt ? a : b))
  return newest.seriesId ?? newest.id
}

function schedule() {
  const series = seriesId()
  if (!series) {
    console.error('No run of this workload found yet — do `setup` and run it first.')
    process.exit(1)
  }
  const tasks = readJson(TASKS, []) ?? []
  const now = Date.now()
  const task = {
    id: TASK_ID,
    name: 'Live continuation probe',
    prompt: '',
    projectId: null,
    // Every minute, so this finishes inside one sitting. Nothing about the
    // feature depends on the interval — the recurrence engine is the
    // Scheduler's own and long tested.
    recurrence: { type: 'interval', hour: 0, minute: 0, every: 1, intervalUnit: 'minutes' },
    enabledTools: [],
    enabled: true,
    conversationId: null,
    createdAt: now,
    updatedAt: now,
    // Due immediately, so the first tick after launch fires it.
    nextRunAt: now,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunSummary: null,
    runs: [],
    runCount: 0,
    continuesSeriesId: series
  }
  fs.mkdirSync(path.dirname(TASKS), { recursive: true })
  fs.writeFileSync(
    TASKS,
    JSON.stringify([...tasks.filter((t) => t.id !== TASK_ID), task], null, 2) + '\n'
  )
  console.log(`armed: continues series ${series}, every minute, due now`)
  console.log('\nLaunch the app with no autorun and leave it running:')
  console.log('  npm run dev')
}

function check() {
  const series = seriesId()
  const runs = (readJson(RUNS, []) ?? []).filter(
    (run) => !run.parentRunId && (run.seriesId ?? run.id) === series
  )
  runs.sort((a, b) => a.createdAt - b.createdAt)

  console.log(`\nseries ${series} — ${runs.length} run(s)`)
  runs.forEach((run, index) => {
    console.log(
      `  run ${index + 1}: ${run.status.padEnd(12)} ${String(run.turnsUsed).padStart(2)} turns  ` +
        `${(run.summary ?? run.lastError ?? '').slice(0, 90).replace(/\n/g, ' ')}`
    )
  })

  const md = fs.existsSync(path.join(WORKSPACE, 'TASKS.md'))
    ? fs.readFileSync(path.join(WORKSPACE, 'TASKS.md'), 'utf8')
    : ''
  const ticked = (md.match(/- \[x\]/gi) ?? []).length
  const files = fs.existsSync(WORKSPACE)
    ? fs
        .readdirSync(WORKSPACE)
        .filter((name) => name.endsWith('.txt'))
        .sort()
    : []

  console.log(`\nchecklist: ${ticked} of 3 ticked`)
  console.log(`files:     ${files.join(', ') || 'none'}`)

  // The question the whole feature turns on. Two runs that each did item one
  // would leave one file and one tick — work repeated, not continued.
  const task = (readJson(TASKS, []) ?? []).find((t) => t.id === TASK_ID)
  if (task) {
    console.log(
      `\nschedule:  ${task.runCount} run(s) recorded, last: ${task.lastRunSummary ?? '—'}`
    )
  }
  if (runs.length >= 2 && files.length >= 2) {
    console.log('\nCONTINUED: later runs did later items rather than repeating the first.')
  } else if (runs.length >= 2) {
    console.log('\nREPEATED or STALLED: more than one run, but not more than one item done.')
  } else {
    console.log('\nnot yet: only one run so far.')
  }
}

function cleanup() {
  const tasks = readJson(TASKS, []) ?? []
  fs.writeFileSync(
    TASKS,
    JSON.stringify(
      tasks.filter((t) => t.id !== TASK_ID),
      null,
      2
    ) + '\n'
  )
  fs.rmSync(SPEC, { force: true })
  console.log('schedule removed, spec deleted')
  console.log(`workspace left at ${WORKSPACE} — delete it by hand if you want it gone`)
}

const command = process.argv[2]
if (command === 'setup') setup()
else if (command === 'schedule') schedule()
else if (command === 'check') check()
else if (command === 'cleanup') cleanup()
else {
  console.error('usage: node scripts/live-continuation.mjs setup|schedule|check|cleanup')
  process.exit(1)
}
