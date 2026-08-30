// Score an Anodex Workspace run the way `ct-criteria.mjs` scores a Critical
// Thinking run: from what the app actually stored, not from what the reply
// claimed.
//
// Usage:
//   node scripts/ws-criteria.mjs                 # newest conversation, any project
//   node scripts/ws-criteria.mjs <substring>     # newest whose project/title matches
//   VERBOSE=1 node scripts/ws-criteria.mjs       # list every failed tool call
//   ALL=1     node scripts/ws-criteria.mjs       # one summary line per conversation
//
// Two instrumentation bugs were found in the first version of this script and
// are fixed here. Both made it report a defect that did not exist — the exact
// pattern that cost real diagnosis time in the Critical Thinking work.
//
//  1. It sorted by `conversation.updatedAt`. Every stored file shares an
//     `updatedAt` of 2026-08-28T01:5x from a bulk store rewrite, so "newest"
//     was arbitrary: it returned a run from 2026-08-23 while the genuinely
//     newest was 2026-08-26. Real recency comes from `messages[].createdAt`.
//
//  2. It read plan completion from `conversation.plan`, which is a SINGLE slot
//     that `write_plan` replaces (see planTools.ts — "create or replace the
//     visible task plan"). A conversation that ran four plans stores only the
//     fourth. One run was scored "0/7 — a defect the user sees" when it had in
//     fact completed 6/6, 5/5 and 8/8 before starting a fourth plan. Every
//     tool call stores a point-in-time `plan` snapshot, so the true history is
//     recoverable and that is what this reads now.
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.join(process.env.APPDATA, 'anodex', 'conversations')

function lastActivity(data) {
  let max = 0
  for (const message of data.messages ?? []) {
    const at = message.createdAt ?? 0
    if (at > 1e12 && at > max) max = at
  }
  // Fall back to the file-level stamp only when no message carries one.
  return max || data.updatedAt || data.createdAt || 0
}

function conversations() {
  const out = []
  for (const project of fs.readdirSync(ROOT)) {
    const dir = path.join(ROOT, project)
    if (!fs.statSync(dir).isDirectory()) continue
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue
      const full = path.join(dir, file)
      try {
        const data = JSON.parse(fs.readFileSync(full, 'utf8'))
        if (!Array.isArray(data.messages)) continue
        out.push({ project, file, data, at: lastActivity(data) })
      } catch {
        // A conversation being written right now; skip it.
      }
    }
  }
  return out.sort((a, b) => b.at - a.at)
}

/**
 * Every distinct plan the conversation ran, in order, with the last state each
 * one reached.
 *
 * `write_plan` mints fresh step ids, so the first step's id identifies a plan
 * across the snapshots that follow it. A conversation legitimately runs one
 * plan per multi-step request; only the last one survives in
 * `conversation.plan`, which is why counting from there under-reports.
 */
function planHistory(calls, stored) {
  const order = []
  const byKey = new Map()
  for (const call of calls) {
    const plan = call.plan
    if (!plan?.steps?.length) continue
    const key = plan.steps[0].id
    if (!byKey.has(key)) order.push(key)
    byKey.set(key, plan)
  }
  // The stored plan is the most current state of whichever plan is last.
  if (stored?.steps?.length) {
    const key = stored.steps[0].id
    if (!byKey.has(key)) order.push(key)
    byKey.set(key, stored)
  }
  return order.map((key) => {
    const plan = byKey.get(key)
    const done = plan.steps.filter((s) => s.status === 'completed').length
    return { title: plan.title, done, total: plan.steps.length, steps: plan.steps }
  })
}

/**
 * Criterion 4 — claims checked against the settled tool record.
 *
 * This deliberately produces *flags to read*, not a verdict. The Critical
 * Thinking work spent real time on checks that could not tell right from wrong
 * and refused correct output anyway: a wording check that passed "the canvas
 * should be fine now" while stopping "the canvas renders" was abandoned for
 * exactly this reason. Prose cannot be separated from evidence by keyword.
 *
 * So the only thing asserted here is the mechanical half: the reply names a
 * verification it claims to have performed, and no command that could have
 * performed it ran in that turn. A flag is a place to look, and the entry
 * prints the sentence so it can be judged by reading it.
 */
const VERIFICATION_CLAIM =
  /(all (?:\d+ )?(?:tests?|checks?) pass(?:ed|es)?|tests? (?:all )?pass(?:ed|es)?|ALL CHECKS PASSED|smoke test pass(?:ed|es)?|build (?:is )?clean|builds? (?:successfully|clean)|compiles? clean(?:ly)?|verified by running|I ran (?:the )?(?:tests?|build|smoke))/i

/**
 * A command that could actually have produced the claimed evidence, rather than
 * any command at all -- an `ls` in the same turn says nothing about whether the
 * tests pass.
 *
 * Validated against the whole store before being trusted: the loose version
 * ("did any command run") flagged 0 of 40 claims, which is the reading a check
 * gives when it is inert rather than when it is satisfied. This version flags 2
 * of 39, both continuation turns resting on an earlier turn's build -- so it
 * does discriminate, and the answer really is that these runs do not claim
 * verification they never performed.
 */
const COULD_VERIFY =
  /(test|smoke|pytest|unittest|cmake|make|build|compile|npm run|gcc|g\+\+|cl\.exe|python )/i

function ranACommand(message) {
  return (message.toolCalls ?? []).some(
    (call) =>
      call.kind === 'command' &&
      call.status === 'success' &&
      COULD_VERIFY.test(`${call.title ?? ''} ${call.detail ?? ''}`)
  )
}

/**
 * A verification command whose own exit code says it failed.
 *
 * `run_command` records `exit N` in `detail`, so a claim resting on a command
 * that exited non-zero is checkable without reading a word of the reply. This
 * is the case the first version missed: a run executed the smoke test twice,
 * got `exit 1` both times, and reported "I've completed the implementation".
 * A command had run, so the claim passed unflagged.
 */
function failedVerification(message) {
  return (message.toolCalls ?? []).some(
    (call) =>
      call.kind === 'command' &&
      call.status === 'success' &&
      COULD_VERIFY.test(`${call.title ?? ''} ${call.detail ?? ''}`) &&
      /exit\s+[1-9]/i.test(String(call.detail ?? ''))
  )
}

function claimFlags(messages) {
  const flags = []
  for (const [index, message] of messages.entries()) {
    if (message.role !== 'assistant') continue
    const text = String(message.content ?? '')
    if (!VERIFICATION_CLAIM.test(text)) continue
    // Claimed success while its own verification exited non-zero — the
    // strongest flag there is, and it needs no reading of the prose.
    if (failedVerification(message)) {
      const sentence =
        text.split(/(?<=[.!?])\s+/).find((part) => VERIFICATION_CLAIM.test(part)) ??
        text.slice(0, 160)
      flags.push({
        index,
        earlier: false,
        failing: true,
        sentence: sentence.replace(/\s+/g, ' ').trim().slice(0, 180)
      })
      continue
    }
    if (ranACommand(message)) continue
    // The claim may rest on a command from an earlier turn of the same run,
    // which is legitimate on a continuation turn -- so say so rather than
    // treating it as a finding.
    const earlier = messages.slice(0, index).some(ranACommand)
    const sentence =
      text.split(/(?<=[.!?])\s+/).find((part) => VERIFICATION_CLAIM.test(part)) ??
      text.slice(0, 160)
    flags.push({
      index,
      earlier,
      failing: false,
      sentence: sentence.replace(/\s+/g, ' ').trim().slice(0, 180)
    })
  }
  return flags
}

/**
 * Criterion 5, measured by degree rather than by a single worst count.
 *
 * A repeated call is waste when nothing that could have changed its answer
 * happened in between — the same rule the loop guard and the gathering ledger
 * already use. For a file read that means a write to that same file; for
 * anything else (a visual inspection, a shell command) it means any durable
 * change at all.
 *
 * The raw signature count stays the pass/fail bar, because this measure was
 * built to test whether that bar was wrong and found that it is not. Validated
 * against the historical worst offenders, which must still fail: they run
 * 10.7-49.5 wasteful repeats per 100 calls. A run that scored 7 on the raw
 * count scored 14.6 here, in the same band — the crude bar and the careful one
 * agree, so amending the bar would have been a loosening dressed as a fix.
 *
 * Reported anyway because degree is what a fix has to move: "worst repeat 7"
 * cannot show progress, while "29 wasted calls in 198" can.
 */
const FILE_READS = new Set(['read_file', 'read_file_range'])

function wastefulRepeats(calls) {
  const target = (call) =>
    String(call.title ?? '')
      .replace(/^(Edit|Read|Write|Append|Patch|Replace lines in|Replace lines|Inspect)\s+/, '')
      .split(' ')[0]
  const lastSeen = new Map()
  const waste = []
  for (const [index, call] of calls.entries()) {
    const signature = `${call.name}::${String(call.title ?? '').slice(0, 80)}`
    // A refused repeat produced nothing and still cost a round trip, so it is
    // waste without needing to ask whether anything changed. Skipping these
    // made the measure blind to the worst run recorded: 642 identical
    // `find_skill` calls, all blocked, scored 4.6 per 100 because every repeat
    // was an error.
    if (call.status === 'error') {
      if (lastSeen.has(signature)) waste.push({ signature, gap: index - lastSeen.get(signature) })
      lastSeen.set(signature, index)
      continue
    }
    const previous = lastSeen.get(signature)
    if (previous !== undefined) {
      const between = calls.slice(previous + 1, index)
      const couldHaveChanged = FILE_READS.has(call.name)
        ? between.some(
            (other) =>
              other.status === 'success' && other.kind === 'write' && target(other) === target(call)
          )
        : between.some(
            (other) =>
              other.status === 'success' && (other.kind === 'write' || other.kind === 'command')
          )
      if (!couldHaveChanged) waste.push({ signature, gap: index - previous })
    }
    lastSeen.set(signature, index)
  }
  return waste
}

const filter = process.argv[2]?.toLowerCase()
const all = conversations()
const matches = (c) =>
  !filter ||
  c.project.toLowerCase().includes(filter) ||
  String(c.data.title ?? '')
    .toLowerCase()
    .includes(filter)

function score(entry) {
  const { data } = entry
  const messages = data.messages ?? []
  const calls = messages.flatMap((m) => m.toolCalls ?? [])
  const failed = calls.filter((c) => c.status === 'error')
  // Criterion 3 asks whether the workspace tools are reliable. A refused
  // `finish_goal` is not an unreliable tool: it is a control signal the run
  // deliberately declined, and every one measured so far has been a guard
  // working — one run was refused four times, went and completed the steps it
  // was told about, and finished 7/7. Counting those as failures marked that
  // run down to exactly the 5% bar for doing the right thing.
  const workspaceFailed = failed.filter((c) => c.name !== 'finish_goal')
  const workspaceCalls = calls.filter((c) => c.name !== 'finish_goal')
  const plans = planHistory(calls, data.plan)
  const signatures = new Map()
  for (const call of calls) {
    const key = `${call.name}::${String(call.title ?? '').slice(0, 80)}`
    signatures.set(key, (signatures.get(key) ?? 0) + 1)
  }
  const repeated = [...signatures.entries()].filter(([, n]) => n > 2).sort((a, b) => b[1] - a[1])
  const flags = claimFlags(messages)
  const waste = wastefulRepeats(calls)
  return {
    flags,
    waste,
    ...entry,
    messages,
    calls,
    failed,
    plans,
    repeated,
    errorRate: calls.length ? failed.length / calls.length : 0,
    workspaceFailed,
    workspaceRate: workspaceCalls.length ? workspaceFailed.length / workspaceCalls.length : 0,
    worstRepeat: repeated.length ? repeated[0][1] : 0,
    abandoned: plans.filter((p) => p.done < p.total).length
  }
}

if (process.env.ALL) {
  const rows = all
    .filter(matches)
    .map(score)
    .filter((r) => r.calls.length > 0)
  console.log(
    'last activity      project           title                          calls  fail%   plans(done/total)        worstRep'
  )
  for (const r of rows) {
    const plans = r.plans.map((p) => `${p.done}/${p.total}`).join(' ') || '-'
    console.log(
      `${new Date(r.at).toISOString().slice(0, 16)}  ${r.project.padEnd(17)} ${String(
        r.data.title ?? ''
      )
        .slice(0, 30)
        .padEnd(
          30
        )} ${String(r.calls.length).padStart(5)} ${String(Math.round(r.errorRate * 100)).padStart(4)}%  ${plans.padEnd(24)} ${String(r.worstRepeat).padStart(4)}`
    )
  }
  const calls = rows.reduce((a, r) => a + r.calls.length, 0)
  const failed = rows.reduce((a, r) => a + r.failed.length, 0)
  const allPlans = rows.flatMap((r) => r.plans)
  console.log(
    `\n${rows.length} conversations, ${calls} calls, ${failed} failed (${Math.round((failed / calls) * 100)}%)`
  )
  console.log(
    `${allPlans.length} plans run, ${allPlans.filter((p) => p.done === p.total).length} finished, ${allPlans.filter((p) => p.done === 0).length} at zero`
  )
  console.log(
    `repetition over 5x in ${rows.filter((r) => r.worstRepeat > 5).length}/${rows.length} conversations`
  )
  process.exit(0)
}

// A conversation with no messages carries no activity stamp of its own and
// would otherwise win "newest" on the bulk-rewrite fallback alone.
const target = all.find((c) => matches(c) && (c.data.messages ?? []).length > 0)
if (!target) {
  console.error(filter ? `No conversation matching "${filter}".` : 'No conversations found.')
  process.exit(1)
}
const r = score(target)

console.log(`conversation: ${r.data.title ?? '(untitled)'}`)
console.log(`project:      ${r.project}`)
console.log(`file:         ${r.file}`)
console.log(`last activity:${new Date(r.at).toISOString()}`)
console.log(`messages:     ${r.messages.length}`)
console.log('')
console.log(`tool calls:   ${r.calls.length}`)
const byTool = {}
for (const call of r.failed) byTool[call.name] = (byTool[call.name] ?? 0) + 1
console.log(
  `failed:       ${r.failed.length} (${Math.round(r.errorRate * 100)}%)  ${r.failed.length ? JSON.stringify(byTool) : ''}`
)
console.log(
  `  of which workspace-tool failures (criterion 3): ${r.workspaceFailed.length} (${Math.round(r.workspaceRate * 100)}%)` +
    `${r.failed.length !== r.workspaceFailed.length ? ' — the rest are finish_goal refusals, which are guard decisions' : ''}`
)
console.log(`plans run:    ${r.plans.length}`)
for (const [i, p] of r.plans.entries()) {
  const flag = p.done === p.total ? '' : '   <- left unfinished'
  console.log(
    `              ${i + 1}. ${p.done}/${p.total}  ${String(p.title).slice(0, 60)}${flag}`
  )
}
if (r.plans.length === 0) console.log('              (no plan recorded)')
const per100 = r.calls.length ? ((r.waste.length / r.calls.length) * 100).toFixed(1) : '0'
console.log(
  `wasted calls:  ${r.waste.length} repeat(s) where nothing could have changed the answer (${per100} per 100)`
)
for (const w of r.waste.slice(0, 4))
  console.log(`              ${w.signature.slice(0, 72)} (+${w.gap})`)
console.log(`repeated:     ${r.repeated.length} call signatures used more than twice`)
for (const [sig, n] of r.repeated.slice(0, 5)) console.log(`              ${n}x ${sig}`)
const unbacked = r.flags.filter((f) => !f.earlier)
console.log(
  `claim flags:  ${r.flags.length} verification claim(s) in a turn that ran no command` +
    (r.flags.length ? ` (${unbacked.length} with no command anywhere earlier either)` : '')
)
for (const f of r.flags) {
  console.log(
    `              msg#${f.index}${f.earlier ? ' (earlier command exists)' : ' (NOTHING ran)'}: ${f.sentence}`
  )
}
console.log('              ^ flags to read, not verdicts - prose cannot be judged by keyword')

if (process.env.VERBOSE) {
  console.log('\nfailed calls:')
  for (const call of r.failed) {
    console.log(`  ${call.name}: ${String(call.detail ?? call.result ?? '').slice(0, 200)}`)
  }
}
