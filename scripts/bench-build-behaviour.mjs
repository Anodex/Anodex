// What a run actually did, not just what it cost.
//
// The cost tables said a smaller window was roughly twice as cheap and twice
// as fast at the same quality, across six solo runs with no overlap. That is a
// result without a mechanism, which is the kind most likely to be an artefact.
// This reads the transcripts behind those numbers and asks the obvious
// follow-up: did the runs behave differently, or only cost differently?
//
// Usage: node scripts/bench-build-behaviour.mjs [--large]
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const USER_DATA = path.join(os.homedir(), 'AppData', 'Roaming', 'anodex')
const RUNS = path.join(USER_DATA, 'agent-runs', 'runs.json')
const large = process.argv.includes('--large')
const RESULTS = path.join('scripts', `bench-build-results${large ? '-large' : ''}.json`)

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/**
 * Conversations live per project, so a run's transcript is not where the run
 * record is. Scanning every conversation file once and indexing by id is
 * cheaper than guessing the project — and a missing transcript throws rather
 * than scoring zero, because this exact reader once reported "found nothing"
 * for a run that had done the work.
 */
function conversationIndex() {
  const index = new Map()
  const root = path.join(USER_DATA, 'conversations')
  if (!fs.existsSync(root)) return index
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name)
      const stat = fs.statSync(full)
      if (stat.isDirectory()) stack.push(full)
      else if (name.endsWith('.json')) {
        const conversation = readJson(full, null)
        if (conversation?.id) index.set(conversation.id, conversation)
      }
    }
  }
  return index
}

const READ_TOOLS = new Set([
  'read_file',
  'read_file_range',
  'read_multiple_files',
  'list_directory',
  'search_files',
  'find_files'
])
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'create_directory'])

function behaviourOf(conversation) {
  const calls = []
  for (const message of conversation?.messages ?? []) {
    for (const call of message.toolCalls ?? []) calls.push(call)
  }
  const byName = new Map()
  let readChars = 0
  let writeChars = 0
  for (const call of calls) {
    byName.set(call.name, (byName.get(call.name) ?? 0) + 1)
    const size = (call.resultText ?? call.detail ?? '').length
    if (READ_TOOLS.has(call.name)) readChars += size
    if (WRITE_TOOLS.has(call.name)) writeChars += size
  }
  return {
    calls: calls.length,
    reads: calls.filter((c) => READ_TOOLS.has(c.name)).length,
    writes: calls.filter((c) => WRITE_TOOLS.has(c.name)).length,
    commands: calls.filter((c) => c.name === 'run_command').length,
    readChars,
    writeChars,
    byName: [...byName.entries()].sort((a, b) => b[1] - a[1])
  }
}

const runs = readJson(RUNS, []) ?? []
const results = readJson(RESULTS, []) ?? []
const conversations = conversationIndex()

const WINDOW = {
  'off-1job': 65_536,
  'large-off-1job': 65_536,
  'off-3jobs': 21_845,
  'large-off-3jobs': 21_845,
  'large-small-window': 21_845,
  'large-mid-window': 32_768
}

console.log(
  '\nwindow   jobs  arm                  turns  calls  reads  writes  cmds  read chars  tokens'
)
console.log('-'.repeat(96))

for (const row of results) {
  if ((row.subAgents ?? 0) > 0) continue
  const window = WINDOW[row.arm]
  if (!window) continue
  const run = runs.find((r) => r.id === row.runId)
  if (!run) {
    console.log(`(no run record for ${row.arm} ${row.runId})`)
    continue
  }
  const conversation = conversations.get(run.conversationId)
  if (!conversation) {
    console.log(`(no transcript for ${row.arm} ${run.conversationId})`)
    continue
  }
  const b = behaviourOf(conversation)
  const jobs = row.arm.includes('3jobs') ? 3 : 1
  console.log(
    `${window.toLocaleString().padStart(7)}  ${String(jobs).padStart(4)}  ` +
      `${row.arm.padEnd(20)} ${String(run.turnsUsed).padStart(5)}  ` +
      `${String(b.calls).padStart(5)}  ${String(b.reads).padStart(5)}  ` +
      `${String(b.writes).padStart(6)}  ${String(b.commands).padStart(4)}  ` +
      `${b.readChars.toLocaleString().padStart(10)}  ${run.tokensUsed.toLocaleString().padStart(7)}`
  )
}

if (process.argv.includes('--tools')) {
  console.log('\n--- tool mix per run ---')
  for (const row of results) {
    if ((row.subAgents ?? 0) > 0 || !WINDOW[row.arm]) continue
    const run = runs.find((r) => r.id === row.runId)
    const conversation = run && conversations.get(run.conversationId)
    if (!conversation) continue
    const b = behaviourOf(conversation)
    console.log(
      `\n${WINDOW[row.arm].toLocaleString()} ${row.arm}: ` +
        b.byName.map(([name, count]) => `${name}×${count}`).join(', ')
    )
  }
}
