// Export benchmark evidence out of Anodex's own stores and into the repo.
//
// Every measurement this project has rests on two stores that are not ours to
// keep: `agent-runs/runs.json` and `conversations/`. Both belong to the running
// app, both are pruned, and both have already been lost once — the records that
// would have identified a run of blank trailing messages were cleared before
// anyone could read them, and that entry sat unresolvable for days as a result.
//
// This writes a compact row per attributed run: what produced it, what it cost,
// how it ended, and the call-level counts a later question is likely to need.
// Not transcripts — those are large, and the questions worth asking later are
// about outcomes and rates, which the counts answer.
//
// Usage: node scripts/bench-export.mjs [output.json]
import fs from 'node:fs'
import path from 'node:path'

const APPDATA = process.env.APPDATA ?? ''
const RUNS = path.join(APPDATA, 'anodex', 'agent-runs', 'runs.json')
const CONVERSATIONS = path.join(APPDATA, 'anodex', 'conversations')
const OUT = process.argv[2] ?? path.join('docs', 'data', 'benchmark-runs.json')

if (!fs.existsSync(RUNS)) {
  console.error('No run store at', RUNS)
  process.exit(1)
}

/** Every stored conversation, by id, so a run can be joined to its calls. */
function conversationsById() {
  const out = new Map()
  if (!fs.existsSync(CONVERSATIONS)) return out
  for (const project of fs.readdirSync(CONVERSATIONS)) {
    const dir = path.join(CONVERSATIONS, project)
    if (!fs.statSync(dir).isDirectory()) continue
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue
      try {
        const conversation = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
        out.set(conversation.id, conversation)
      } catch {
        // Half-written while the app runs; skipping one is better than dying.
      }
    }
  }
  return out
}

/**
 * The call-level shape of a run.
 *
 * `refused` is kept apart from `faulted` because pooling them once put a run at
 * "64% of tool calls failed" when 91% of those were guards correctly turning
 * away a model that repeated itself. A row that cannot tell those apart cannot
 * answer anything useful later.
 */
function callCounts(conversation) {
  let calls = 0
  let succeeded = 0
  let refused = 0
  let faulted = 0
  let turns = 0
  let turnsWithNoCall = 0
  const repeats = new Map()

  for (const message of conversation?.messages ?? []) {
    if (message.role !== 'assistant') continue
    turns++
    const toolCalls = message.toolCalls ?? []
    if (toolCalls.length === 0) turnsWithNoCall++
    for (const call of toolCalls) {
      calls++
      if (call.status === 'success') succeeded++
      else if (String(call.detail ?? '').startsWith('Blocked:')) refused++
      else faulted++
      const signature = `${call.name}::${String(call.title ?? '').slice(0, 60)}`
      repeats.set(signature, (repeats.get(signature) ?? 0) + 1)
    }
  }

  const mostRepeated = [...repeats.entries()].sort((a, b) => b[1] - a[1])[0]
  return {
    turns,
    turnsWithNoCall,
    calls,
    succeeded,
    refused,
    faulted,
    mostRepeatedCall: mostRepeated ? { signature: mostRepeated[0], times: mostRepeated[1] } : null
  }
}

const conversations = conversationsById()
const runs = JSON.parse(fs.readFileSync(RUNS, 'utf8'))

const rows = runs
  .filter((run) => run.turnsUsed > 0)
  .map((run) => {
    const steps = run.plan?.steps ?? []
    return {
      id: run.id,
      at: new Date(run.createdAt ?? 0).toISOString(),
      // Null for anything recorded before provenance existed. Kept rather than
      // guessed: an unattributable run is a fact about the record.
      model: run.ranWith?.model ?? null,
      contextSize: run.ranWith?.contextSize ?? null,
      provider: run.provider,
      goalFirstLine: String(run.goal ?? '')
        .split('\n')[0]
        .slice(0, 120),
      status: run.status,
      endedBecause: run.lastError ? String(run.lastError).split('.')[0].slice(0, 120) : null,
      flaggedTurns: run.flaggedTurns ?? 0,
      turnsUsed: run.turnsUsed,
      maxTurns: run.maxTurns,
      tokensUsed: run.tokensUsed,
      maxTokens: run.maxTokens,
      activeMinutes: Math.round((run.activeMs ?? 0) / 60000),
      planSteps: steps.length,
      planComplete: steps.filter((step) => step.status === 'completed').length,
      ...callCounts(conversations.get(run.conversationId))
    }
  })

const attributed = rows.filter((row) => row.model)
const payload = {
  exportedAt: new Date().toISOString(),
  note:
    'Exported from Anodex own stores, which are pruned by the app. Rows without a model ' +
    'predate run provenance and cannot be attributed - do not pool them with the rest.',
  totalRuns: rows.length,
  attributedRuns: attributed.length,
  models: [...new Set(attributed.map((row) => `${row.model} @ ${row.contextSize}`))].sort(),
  runs: rows
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

console.log(`Wrote ${rows.length} run(s) (${attributed.length} attributed) to ${OUT}`)
for (const model of payload.models) console.log('  ', model)
