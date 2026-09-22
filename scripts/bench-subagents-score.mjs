// Score a sub-agent A/B arm against the planted-bug answer key.
//
// Reads the persisted run store, takes the newest run whose goal matches the
// corpus, and scores what it reported against `ANSWER_KEY`. A parent's report
// is scored together with everything its sub-agents reported, because a
// delegation's output is the whole fan-out — scoring the parent alone would
// mark a sub-agent's find as a miss.
//
// Usage: node scripts/bench-subagents-score.mjs [--json] [--all]
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { ANSWER_KEY } from './bench-subagents-fixture.mjs'

const USER_DATA = path.join(os.homedir(), 'AppData', 'Roaming', 'anodex')
const RUNS = path.join(USER_DATA, 'agent-runs', 'runs.json')
const CONVERSATIONS = path.join(USER_DATA, 'conversations')

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** Everything a run said: its summary, plus every assistant turn it produced. */
function runText(run) {
  const parts = [run.summary ?? '', run.lastError ?? '']
  if (run.conversationId) {
    const conversation = readJson(path.join(CONVERSATIONS, `${run.conversationId}.json`))
    for (const message of conversation?.messages ?? []) {
      if (message.role !== 'assistant') continue
      parts.push(message.content ?? '')
      // Tool detail lines carry findings too when a model reports as it goes.
      for (const call of message.toolCalls ?? []) parts.push(call.detail ?? '')
    }
  }
  return parts.join('\n')
}

/**
 * Whether a report actually found this bug.
 *
 * Both halves are required: it has to name the place and describe the fault.
 * Naming `money.py` and saying it looks fine is not a find, and "there is a
 * rounding bug somewhere" is not one either — a claim nobody can act on has
 * not found anything, and scoring it as a hit would flatter every arm equally
 * and tell us nothing.
 */
function found(bug, text) {
  return bug.must.every((re) => re.test(text)) && bug.any.some((re) => re.test(text))
}

function scoreRun(run, allRuns) {
  const children = allRuns.filter((other) => other.parentRunId === run.id)
  const text = [run, ...children].map(runText).join('\n')
  const hits = ANSWER_KEY.filter((bug) => found(bug, text))
  const childTokens = children.reduce((sum, child) => sum + (child.tokensUsed ?? 0), 0)
  return {
    runId: run.id,
    status: run.status,
    subAgents: children.length,
    subAgentStatuses: children.map((child) => child.status),
    // The parent's own total already includes what its children spent — see
    // `splitRunBudget` and the fold in `AgentRunService.runLoop`. Reported
    // separately so a reader can see the share rather than infer it.
    tokensTotal: run.tokensUsed ?? 0,
    tokensInChildren: childTokens,
    turns: run.turnsUsed ?? 0,
    // Time actually spent working, not wall-clock since creation — a run that
    // waited on anything would otherwise look slower than it was.
    activeSeconds: Math.round((run.activeMs ?? 0) / 1000),
    found: hits.length,
    total: ANSWER_KEY.length,
    hits: hits.map((bug) => bug.id),
    missed: ANSWER_KEY.filter((bug) => !hits.includes(bug)).map((bug) => bug.id)
  }
}

const runs = readJson(RUNS, [])
if (!Array.isArray(runs) || runs.length === 0) {
  console.error(`No runs found at ${RUNS}`)
  process.exit(1)
}

// Parents only: a sub-agent is scored as part of the run that sent it.
const candidates = runs
  .filter((run) => !run.parentRunId && /find them|real bugs in it/i.test(run.goal ?? ''))
  .sort((a, b) => b.createdAt - a.createdAt)

if (candidates.length === 0) {
  console.error('No bug-hunt runs found. Has an arm been run yet?')
  process.exit(1)
}

const wanted = process.argv.includes('--all') ? candidates : candidates.slice(0, 1)
const scored = wanted.map((run) => ({
  ...scoreRun(run, runs),
  arm: /exactly (\w+) sub-agent/i.exec(run.goal ?? '')?.[1] ?? 'off',
  startedAt: new Date(run.createdAt).toISOString()
}))

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(scored, null, 2))
} else {
  for (const result of scored) {
    console.log(`\narm=${result.arm}  ${result.startedAt}  run ${result.runId}`)
    console.log(`  status         ${result.status}`)
    console.log(`  sub-agents     ${result.subAgents} ${result.subAgentStatuses.join(',')}`)
    console.log(`  found          ${result.found}/${result.total}`)
    console.log(`  turns          ${result.turns}`)
    console.log(`  tokens         ${result.tokensTotal} (${result.tokensInChildren} in sub-agents)`)
    console.log(`  active         ${result.activeSeconds}s`)
    if (result.missed.length) console.log(`  missed         ${result.missed.join(', ')}`)
  }
}
