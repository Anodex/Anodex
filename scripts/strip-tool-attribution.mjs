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

// Matched against whole lines. Each pattern targets an attribution line, not a
// mention — a commit body that discusses these tools in prose is left alone.
const ATTRIBUTION_PATTERNS = [
  // `Co-Authored-By: Claude <noreply@anthropic.com>` and relatives. Keyed on
  // the tool identity rather than the trailer alone, so a real human
  // co-author trailer still survives.
  /^\s*co-authored-by:.*\b(claude|codex|copilot|cursor|anthropic\.com|openai\.com)\b/i,
  // `🤖 Generated with [Claude Code](...)` and its variants.
  /^\s*(?:🤖\s*)?generated with\b.*\b(claude|codex|copilot|cursor)\b/i,
  // Assorted sign-off shapes seen from agent tooling.
  /^\s*(?:signed-off-by|assisted-by|authored-by):.*\b(claude|codex|copilot|cursor)\b/i
]

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
