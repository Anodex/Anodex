#!/usr/bin/env node
/**
 * Check what the Scheduler actually did with the tasks a test created.
 *
 * Usage: node scripts/scheduler-verify.mjs [--clean]
 *
 * Pair with `scripts/chat-script-scheduler.json`, which asks chat to create a
 * one-shot two minutes out and a repeating task, then leave the app running so
 * the scheduler can reach them. It ticks every thirty seconds, so allow about
 * three minutes before checking.
 *
 * The Scheduler was the least-tested surface in the app: its only bug found
 * before this was noticed sideways while testing email, where `parseWhen`
 * silently dropped the date from "9:00 AM on 9-4-26" and set the reminder for
 * the wrong day. Firing is the part no unit test can prove, because it needs a
 * real clock, a real model and a running app.
 *
 * `--clean` removes the tasks these tests create and leaves everything else
 * alone — a test should not quietly accumulate entries in a real Scheduler.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const TASKS = join(
  process.env.APPDATA ?? join(homedir(), 'AppData/Roaming'),
  'anodex/scheduled-tasks/tasks.json'
)

/** Exactly the names `chat-script-scheduler.json` asks for. */
const TEST_TASK_NAMES = ['Scheduler smoke test', 'Interval test']

const raw = JSON.parse(readFileSync(TASKS, 'utf-8'))
const tasks = Array.isArray(raw) ? raw : (raw.tasks ?? [])

if (process.argv.includes('--clean')) {
  const kept = tasks.filter((task) => !TEST_TASK_NAMES.includes(task.name))
  const removed = tasks.length - kept.length
  writeFileSync(TASKS, JSON.stringify(Array.isArray(raw) ? kept : { ...raw, tasks: kept }, null, 2))
  console.log(`removed ${removed} test task(s); ${kept.length} left untouched`)
  process.exit(0)
}

const checks = []
const oneShot = tasks.find((task) => task.name === 'Scheduler smoke test')
const repeating = tasks.find((task) => task.name === 'Interval test')

check('one-shot task was created', Boolean(oneShot))
check(
  'one-shot carries an absolute runAt, not a bare time',
  // The bug this exists for: a dated reminder that keeps only the time fires on
  // the next occurrence of that clock reading, which is usually tomorrow.
  typeof oneShot?.recurrence?.runAt === 'number'
)
check('one-shot fired', Boolean(oneShot?.lastRunAt))
check('one-shot succeeded', oneShot?.lastRunStatus === 'success')
check('one-shot recorded a run', (oneShot?.runs ?? []).length > 0)

check('repeating task was created', Boolean(repeating))
check('repeating task is an interval rule', repeating?.recurrence?.type === 'interval')
check(
  'a sub-minimum interval was raised rather than accepted',
  // "every 1 minute" must not be taken literally: a task re-firing that often
  // hammers a local model. The floor is applied at parse time.
  (repeating?.recurrence?.every ?? 0) > 1
)
check('repeating task fired', Boolean(repeating?.lastRunAt))
check(
  'repeating task rescheduled itself after firing',
  Boolean(repeating?.nextRunAt && repeating.nextRunAt > (repeating.lastRunAt ?? 0))
)

const passed = checks.filter((entry) => entry.ok).length
for (const entry of checks) console.log(`  ${entry.ok ? 'PASS' : 'FAIL'}  ${entry.label}`)
console.log(`score: ${passed}/${checks.length}`)
console.log('\nThe reply the scheduled run produced is in its own conversation,')
console.log('titled after the task and marked origin: scheduled.')
process.exit(passed === checks.length ? 0 : 1)

function check(label, ok) {
  checks.push({ label, ok: Boolean(ok) })
}
