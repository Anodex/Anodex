// Reading a run's own words back off disk.
//
// Shared by the scorer and the report so there is one implementation of the
// thing that silently returned nothing: conversations are stored per project,
// `conversations/<projectDir>/<id>.json`, not flat. Looking in the flat path
// found no file, returned just the summary, and scored a run with 21,431
// characters of findings as 0 out of 12 — a number that looked like a result.
//
// So this refuses to be quiet about it. A run whose transcript cannot be
// found throws rather than scoring low, because "I could not read it" and "it
// found nothing" are different facts and only one of them is about the model.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const USER_DATA = path.join(os.homedir(), 'AppData', 'Roaming', 'anodex')
export const RUNS_FILE = path.join(USER_DATA, 'agent-runs', 'runs.json')
const CONVERSATIONS = path.join(USER_DATA, 'conversations')

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** Where a conversation lives, searching every project folder. */
function conversationPath(id) {
  const flat = path.join(CONVERSATIONS, `${id}.json`)
  if (fs.existsSync(flat)) return flat
  for (const entry of fs.readdirSync(CONVERSATIONS, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const nested = path.join(CONVERSATIONS, entry.name, `${id}.json`)
    if (fs.existsSync(nested)) return nested
  }
  return null
}

/**
 * Everything a run said: its summary, every assistant turn, and the detail
 * line of every tool call it settled.
 *
 * Tool details are included because a model reviewing code often states a
 * finding as it reads rather than saving it all for the summary, and a run
 * that was cut off mid-way may never have written a summary at all.
 */
export function runText(run) {
  const parts = [run.summary ?? '', run.lastError ?? '']
  if (run.conversationId) {
    const file = conversationPath(run.conversationId)
    if (!file) {
      throw new Error(
        `Cannot find the transcript for run ${run.id} (conversation ${run.conversationId}). ` +
          'Refusing to score it as a miss — that would report a reading failure as a model failure.'
      )
    }
    const conversation = readJson(file)
    for (const message of conversation?.messages ?? []) {
      if (message.role !== 'assistant') continue
      parts.push(message.content ?? '')
      for (const call of message.toolCalls ?? []) parts.push(call.detail ?? '')
    }
  }
  return parts.join('\n')
}

/** Whether a run has finished, so it can be scored at all. */
export function isTerminal(run) {
  return run.status === 'done' || run.status === 'stopped' || run.status === 'error'
}

/**
 * Every finished bug-hunt run, oldest first, parents only.
 *
 * Runs still in flight are excluded rather than scored low: a run on turn one
 * has found nothing yet, and counting that as a result would drag whichever
 * arm happened to be running when the report was generated.
 */
export function bugHuntRuns() {
  const all = readJson(RUNS_FILE, []) ?? []
  const parents = all
    .filter(
      (run) =>
        !run.parentRunId && isTerminal(run) && /find them|real bugs in it/i.test(run.goal ?? '')
    )
    .sort((a, b) => a.createdAt - b.createdAt)
  return { all, parents }
}

/** Which arm a run belongs to, read from its own goal rather than assumed. */
export function armOf(run) {
  const match = /exactly (one|two|three|\d+) sub-agent/i.exec(run.goal ?? '')
  if (!match) return 'off'
  return { one: '1', two: '2', three: '3' }[match[1].toLowerCase()] ?? match[1]
}

/**
 * How many tool calls a run settled, and how many were refused.
 *
 * Counted from the transcript rather than from the run record, because the
 * record keeps totals and the question here is about kinds: a read-only run
 * lives entirely on gathering calls, and the gathering guard caps those at 34
 * per run with no way to reset. Whether a delegating arm found more because
 * it looked *smarter* or merely because three ledgers carry three times the
 * budget is the difference between a feature and an accident.
 */
export function toolCalls(run) {
  if (!run.conversationId) return { reads: 0, refused: 0 }
  const file = conversationPath(run.conversationId)
  if (!file) return { reads: 0, refused: 0 }
  const conversation = readJson(file)
  let reads = 0
  let refused = 0
  for (const message of conversation?.messages ?? []) {
    for (const call of message.toolCalls ?? []) {
      if (call.status === 'denied' || call.status === 'error') refused++
      else reads++
    }
  }
  return { reads, refused }
}
