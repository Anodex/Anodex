// Strips coding-agent attribution out of a commit message before it is
// recorded. Run from the `commit-msg` hook, so it applies to every commit made
// in this repo regardless of which tool produced the message.
//
// The concern is narrow and specific: what gets published to git history. The
// product names themselves are legitimate elsewhere in this repo — Anodex ships
// Anthropic and OpenAI providers, and their names appear throughout `src/` as
// product surface. Nothing here touches that. This only removes trailers and
// sign-off lines that credit the tool used to write a commit, because those
// render as co-author avatars and tool badges on the commit page.
//
// A history rewrite already cleared ~200 such trailers once; this hook is what
// keeps them from accumulating again.
import { readFileSync, writeFileSync } from 'node:fs'

// Shared with the CI check that fails a pull request carrying one of these, so
// the hook and the gate cannot disagree about what attribution is.
import { ATTRIBUTION_PATTERNS } from './attribution-patterns.mjs'

const messagePath = process.argv[2]

if (!messagePath) {
  console.error('strip-tool-attribution: expected a commit message file path')
  process.exit(1)
}

const original = readFileSync(messagePath, 'utf-8')

// Comment lines are git's own scaffolding (the `# Please enter...` block) and
// are stripped by git anyway; leave them untouched so nothing shifts.
const kept = original
  .split('\n')
  .filter((line) => !ATTRIBUTION_PATTERNS.some((pattern) => pattern.test(line)))
  .join('\n')

if (kept === original) {
  process.exit(0)
}

// Removing a trailer block usually leaves a dangling blank line before it.
// Collapse runs of blank lines at the very end down to a single trailing
// newline so the message does not end in whitespace.
const cleaned = `${kept.replace(/\s+$/, '')}\n`

writeFileSync(messagePath, cleaned, 'utf-8')
console.error('strip-tool-attribution: removed coding-agent attribution from the commit message')
