#!/usr/bin/env node
// One command from a dirty working tree to a merged `main`.
//
//   npm run ship -- "fix(updates): stop the notice flickering"
//
// Branch, commit, push, open a pull request, wait for CI, merge, clean up. The
// same five steps done by hand, which is the reason people stop doing them.
//
// This deliberately keeps the pull request rather than pushing straight to
// `main`. 02af5ce reached `main` without CI and shipped a stale protocol
// artifact that broke every open pull request until somebody noticed. The gate
// is worth keeping; the typing is not.
import { execFileSync, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'

const args = process.argv.slice(2)
const has = (flag) => args.includes(`--${flag}`)
const message = args.find((a) => !a.startsWith('--'))

if (!message) {
  console.error('usage: npm run ship -- "<commit message>" [--all] [--no-merge] [--yes]')
  console.error('  --all       include untracked files (default: tracked changes only)')
  console.error('  --no-merge  open the pull request and stop, rather than waiting for CI')
  console.error('  --yes       skip the confirmation (required when not run from a terminal)')
  process.exit(1)
}

const git = (...a) => execFileSync('git', a, { encoding: 'utf-8' }).trim()
const gh = (...a) => execFileSync('gh', a, { encoding: 'utf-8' }).trim()
/** For long-running commands whose output the person should watch as it happens. */
const live = (cmd, ...a) => spawnSync(cmd, a, { stdio: 'inherit' }).status ?? 1

const DEFAULT_BRANCH = 'main'
const lines = (out) => out.split('\n').filter(Boolean)

// Staged changes win if there are any, so a deliberate `git add -p` is not
// quietly widened into "everything I happened to have open".
const staged = lines(git('diff', '--cached', '--name-only'))
const tracked = lines(git('diff', '--name-only'))
const untracked = lines(git('ls-files', '--others', '--exclude-standard'))

const selected = staged.length ? staged : has('all') ? [...tracked, ...untracked] : tracked

if (selected.length === 0) {
  console.error('Nothing to ship: no staged or modified tracked files.')
  if (untracked.length) console.error('There are untracked files; pass --all to include them.')
  process.exit(1)
}

// Shown, and confirmed, BEFORE anything is staged or committed. This script's
// whole job is to make a handful of irreversible-ish steps cheap to trigger,
// which is exactly why it should say out loud what it is about to push to a
// public repository. It has already opened one pull request nobody wanted.
console.log(`\nShipping to ${DEFAULT_BRANCH}:\n`)
for (const file of selected) console.log(`    ${file}`)
if (!staged.length && !has('all') && untracked.length) {
  console.log(`\n  (${untracked.length} untracked file(s) NOT included; pass --all to add them)`)
}
console.log(`\n  ${message}\n`)

if (!has('yes')) {
  if (!process.stdin.isTTY) {
    console.error('Not a terminal, so there is nobody to ask. Re-run with --yes if this is right.')
    process.exit(1)
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = (await rl.question('Ship this? [y/N] ')).trim().toLowerCase()
  rl.close()
  if (answer !== 'y' && answer !== 'yes') {
    console.log('Nothing was changed.')
    process.exit(1)
  }
}

if (!staged.length) {
  git('add', has('all') ? '--all' : '--update')
}

/**
 * `fix(updates): stop the flicker` becomes `fix/stop-the-flicker`, so the branch
 * says the same thing the commit does without a second decision to make.
 */
function branchName(subject) {
  const match = /^(\w+)(?:\([^)]*\))?:\s*(.+)$/.exec(subject)
  const type = match ? match[1] : 'chore'
  const rest = (match ? match[2] : subject)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .split('-')
    .slice(0, 7)
    .join('-')
  return `${type}/${rest || 'change'}`
}

const current = git('rev-parse', '--abbrev-ref', 'HEAD')
const branch = current === DEFAULT_BRANCH ? branchName(message) : current

if (current === DEFAULT_BRANCH) git('switch', '-c', branch)
console.log(`branch  ${branch}`)

// The commit-msg hook strips coding-agent attribution on the way through.
git('commit', '-m', message)
console.log(`commit  ${git('log', '-1', '--format=%h %s')}`)

git('push', '-u', 'origin', branch)

// `--fill` takes the title and body from the commit, so the pull request says
// exactly what the commit says and there is nothing further to write.
const url = gh('pr', 'create', '--fill', '--base', DEFAULT_BRANCH)
console.log(`pr      ${url}`)

if (has('no-merge')) {
  console.log('\nOpened. CI is running; merge it when you are ready.')
  process.exit(0)
}

// GitHub needs a moment to register a new pull request's checks, and asking too
// early gets "no checks reported" - not a failure, just the answer arriving
// before the question means anything. The first version of this script read
// that as a red build and refused to merge a perfectly good change.
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

process.stdout.write('\nWaiting for CI to start')
let started = false
for (let attempt = 0; attempt < 24 && !started; attempt += 1) {
  const probe = spawnSync('gh', ['pr', 'checks', url], { encoding: 'utf-8' })
  started = !/no checks reported/i.test(`${probe.stdout ?? ''}${probe.stderr ?? ''}`)
  if (!started) {
    process.stdout.write('.')
    sleep(5000)
  }
}
console.log()

if (!started) {
  console.error(`No checks appeared after two minutes. Have a look yourself:\n  ${url}`)
  process.exit(1)
}

console.log('\nWaiting for CI...')
// Not `execFileSync`: this takes minutes, and the checks should appear as they
// land rather than arriving all at once when it is already over.
if (live('gh', 'pr', 'checks', url, '--watch', '--fail-fast') !== 0) {
  console.error(
    `\nCI failed. Nothing merged; the branch and pull request are still there:\n  ${url}`
  )
  process.exit(1)
}

gh('pr', 'merge', url, '--merge', '--delete-branch')
git('switch', DEFAULT_BRANCH)
git('pull', '--ff-only')

console.log(`\nMerged, and ${DEFAULT_BRANCH} is up to date here.`)
