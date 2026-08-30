// Aggregate statistics across stored agent runs, segmented by what produced
// them.
//
// Written because the numbers this project had were not comparable. A
// before/after on tool-failure rate looked like a 64% improvement and was
// mostly model mix: six models were tested in one day and, until `ranWith` was
// recorded, no stored run said which one it used. Anything this prints for a
// run without provenance is labelled "unattributed" rather than pooled, because
// pooling is exactly how that mistake was made.
//
// Usage:
//   node scripts/ws-stats.mjs                 # segment by model
//   node scripts/ws-stats.mjs --by=context    # segment by context window
//   node scripts/ws-stats.mjs --since=2026-08-30
import fs from 'node:fs'
import path from 'node:path'

const RUNS = path.join(process.env.APPDATA, 'anodex', 'agent-runs', 'runs.json')
const CONVERSATIONS = path.join(process.env.APPDATA, 'anodex', 'conversations')

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=')
    return [k, v ?? true]
  })
)
// `--since=2026-08-30` with no zone is parsed as local time, which is how an
// earlier invocation silently matched nothing and printed "0 run(s)". A filter
// that quietly removes everything is worse than no filter, so this says what it
// understood and complains if it excluded the lot.
const since = args.has('since') ? Date.parse(String(args.get('since'))) : 0
if (args.has('since') && Number.isNaN(since)) {
  console.error(`Could not read --since=${args.get('since')}. Use an ISO date, e.g. 2026-08-30.`)
  process.exit(1)
}
const segmentBy = args.get('by') ?? 'model'

function conversations() {
  const out = new Map()
  if (!fs.existsSync(CONVERSATIONS)) return out
  for (const project of fs.readdirSync(CONVERSATIONS)) {
    const dir = path.join(CONVERSATIONS, project)
    if (!fs.statSync(dir).isDirectory()) continue
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue
      try {
        const c = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
        out.set(c.id, c)
      } catch {
        // A conversation being written right now; skip it rather than die.
      }
    }
  }
  return out
}

/** Everything measurable about one run, from the settled record only. */
function measure(run, conversation) {
  const steps = run.plan?.steps ?? []
  const planTotal = steps.length
  const planDone = steps.filter((s) => s.status === 'completed').length

  let calls = 0
  let failed = 0
  // A call a guard turned away is Anodex working, not Anodex breaking. Pooling
  // the two put a 4B run at "64% of tool calls failed" when 91% of those were
  // refusals of a model repeating itself, and only one call in 455 was an
  // actual fault. A dashboard that reads as a defect rate must not count
  // correct behaviour as a defect.
  let refused = 0
  let repeats = 0
  const seen = new Set()
  for (const message of conversation?.messages ?? []) {
    for (const call of message.toolCalls ?? []) {
      calls++
      if (call.status === 'error') {
        if (String(call.detail ?? '').startsWith('Blocked:')) refused++
        else failed++
      }
      const signature = `${call.name}::${String(call.title ?? '').slice(0, 60)}`
      if (seen.has(signature)) repeats++
      seen.add(signature)
    }
  }

  return {
    finished: run.status === 'done',
    planComplete: planTotal > 0 && planDone === planTotal,
    planPartial: planTotal > 0 && planDone < planTotal,
    flagged: (run.flaggedTurns ?? 0) > 0,
    calls,
    failed,
    refused,
    repeats,
    // Share of each budget actually spent. A run that stopped with all three
    // barely touched decided to stop; one that spent a budget was stopped.
    turnShare: run.maxTurns ? run.turnsUsed / run.maxTurns : 0,
    tokenShare: run.maxTokens ? run.tokensUsed / run.maxTokens : 0
  }
}

function segmentOf(run) {
  if (!run.ranWith) return 'unattributed (recorded before provenance existed)'
  if (segmentBy === 'context') return `ctx ${run.ranWith.contextSize ?? '?'}`
  return `${run.ranWith.model ?? '?'} @ ${run.ranWith.contextSize ?? '?'}`
}

const convs = conversations()
const runs = JSON.parse(fs.readFileSync(RUNS, 'utf8')).filter(
  (r) => r.turnsUsed > 0 && (r.createdAt ?? 0) >= since
)

const groups = new Map()
for (const run of runs) {
  const key = segmentOf(run)
  if (!groups.has(key)) groups.set(key, [])
  groups.get(key).push(measure(run, convs.get(run.conversationId)))
}

function pct(n, d) {
  return d === 0 ? '  n/a' : `${String(Math.round((100 * n) / d)).padStart(4)}%`
}

if (args.has('since')) {
  console.log(`--since=${args.get('since')} read as ${new Date(since).toISOString()}`)
}
if (runs.length === 0) {
  console.error(
    'No runs matched. ' +
      (args.has('since')
        ? 'A date with no timezone is read as local time - try an earlier one, or drop --since.'
        : 'No runs are stored yet.')
  )
  process.exit(1)
}
console.log(`\n${runs.length} run(s), segmented by ${segmentBy}\n`)
for (const [key, rows] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const n = rows.length
  const calls = rows.reduce((a, r) => a + r.calls, 0)
  console.log(key)
  console.log(`  runs                ${String(n).padStart(5)}`)
  console.log(`  finished            ${pct(rows.filter((r) => r.finished).length, n)}`)
  console.log(`  plan complete       ${pct(rows.filter((r) => r.planComplete).length, n)}`)
  console.log(
    `  finished, plan open ${pct(rows.filter((r) => r.finished && r.planPartial).length, n)}`
  )
  console.log(`  flagged             ${pct(rows.filter((r) => r.flagged).length, n)}`)
  console.log(
    `  tool calls faulted  ${pct(
      rows.reduce((a, r) => a + r.failed, 0),
      calls
    )}`
  )
  console.log(
    `  refused by a guard  ${pct(
      rows.reduce((a, r) => a + r.refused, 0),
      calls
    )}`
  )
  console.log(
    `  repeat calls        ${pct(
      rows.reduce((a, r) => a + r.repeats, 0),
      calls
    )}`
  )
  const spare = rows.filter((r) => r.finished && r.planPartial && r.tokenShare < 0.8)
  console.log(`  stopped early with budget left ${String(spare.length).padStart(3)} of ${n}`)
  console.log()
}
if ([...groups.keys()].some((k) => k.startsWith('unattributed'))) {
  console.log(
    'Runs from before `ranWith` was recorded cannot be attributed to a model and\n' +
      'are kept separate. Do not compare across that line: six models were tested in\n' +
      'one day and pooling them is what made an earlier comparison meaningless.\n'
  )
}
