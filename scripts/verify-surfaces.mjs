#!/usr/bin/env node
/**
 * One command to answer "did this change damage another surface?".
 *
 * Usage:
 *   node scripts/verify-surfaces.mjs            # fast tier, seconds
 *   node scripts/verify-surfaces.mjs --models   # also run the model matrices
 *
 * Anodex's surfaces share almost everything underneath: one prompt module, one
 * tool registry, one ranking function, two transports. So a change aimed at
 * chat lands in email, and a change to the shared tool priority list reorders
 * whatever the agent had. That has actually happened here more than once — a
 * build-run ordering silently evicted chat's and email's own tools, and an
 * email fix was once credited to a budget change in a transport the measured
 * model never used.
 *
 * The instinct is to run everything after every change. That takes over an
 * hour on this machine, so it does not get run, and a check that does not get
 * run is not a safeguard. Hence two tiers.
 *
 * **Fast tier (seconds, always run it).** Unit tests, including the surface
 * isolation tests that assert *which* surfaces a shared list reorders and that
 * each surface still gets its own core prompt. These catch the whole class of
 * cross-surface damage without loading a model, because the coupling being
 * tested is structural — which tools a surface gets, and in what order.
 *
 * **Slow tier (`--models`, tens of minutes).** The behavioural matrices. Needed
 * when a change could alter what a model *does* rather than what it is handed:
 * prompt wording, tool descriptions, context budgets.
 *
 * Neither tier reaches Critical Thinking or the workspace by running them —
 * those two are scored from runs already on disk, so they report the state of
 * the last real run rather than proving anything about this change. They are
 * included because a surface silently absent from a report is worse than one
 * reported as stale.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const withModels = process.argv.includes('--models')
const results = []

/**
 * Run one check and record its outcome without stopping the rest.
 *
 * `shell` is opt-in rather than on by default for Windows. Defaulting it to
 * true broke every node check here: `process.execPath` is
 * "C:\Program Files\nodejs\node.exe", and a shell splits it at the space, so
 * three checks that exit 0 when run by hand were reported as failures. Only
 * `npx` needs a shell, because on Windows it is a .cmd.
 */
function check(name, command, args, { optional = false, shell = false } = {}) {
  process.stdout.write(`  ${name} ... `)
  const run = spawnSync(command, args, { encoding: 'utf-8', shell })
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  const ok = run.status === 0
  results.push({ name, ok, optional, output })
  console.log(ok ? 'ok' : optional ? 'SKIPPED/STALE' : 'FAILED')
  return ok
}

console.log('fast tier — structural checks, no model loaded')
check('unit tests (all surfaces)', 'npx', ['vitest', 'run', '--silent'], { shell: true })

// Scored from stored runs rather than fresh ones: these report the last real
// run's state, which is why they are optional rather than gating.
if (existsSync('scripts/ct-criteria.mjs')) {
  check('critical thinking (stored runs)', process.execPath, ['scripts/ct-criteria.mjs'], {
    optional: true
  })
}
if (existsSync('scripts/ws-criteria.mjs')) {
  check('workspace (stored conversations)', process.execPath, ['scripts/ws-criteria.mjs'], {
    optional: true
  })
}

if (withModels) {
  console.log('\nslow tier — behavioural matrices')
  const out = process.env.ANODEX_VERIFY_OUT ?? 'verify-out'
  check('chat (baseline rubric)', process.execPath, [
    'scripts/chat-matrix.mjs',
    `${out}/chat`,
    'qwen4b',
    'qwen27b'
  ])
  check('chat (hard rubric)', process.execPath, [
    'scripts/chat-matrix.mjs',
    `${out}/chat-hard`,
    'qwen4b',
    'qwen27b',
    '--script',
    'scripts/chat-script-hard.json',
    '--criteria',
    'scripts/chat-hard-criteria.mjs'
  ])
  check('email', process.execPath, [
    'scripts/chat-matrix.mjs',
    `${out}/email`,
    'qwen27b',
    '--script',
    'scripts/email-script-matrix.json',
    '--criteria',
    'scripts/email-criteria.mjs'
  ])
}

const failed = results.filter((entry) => !entry.ok && !entry.optional)
const stale = results.filter((entry) => !entry.ok && entry.optional)

console.log('\n' + '-'.repeat(60))
for (const entry of results) {
  console.log(`  ${entry.ok ? 'PASS' : entry.optional ? 'STALE' : 'FAIL'}  ${entry.name}`)
}
if (!withModels) {
  console.log('\n  (behavioural matrices not run — add --models when wording or budgets changed)')
}

for (const entry of failed) {
  console.log(`\n=== ${entry.name} ===\n${entry.output.trim().split('\n').slice(-25).join('\n')}`)
}
if (stale.length) {
  console.log(
    `\n${stale.length} surface(s) reported from stored runs only; re-run them to be sure.`
  )
}

process.exit(failed.length === 0 ? 0 : 1)
