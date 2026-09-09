// The one definition of "coding-agent attribution" in this repository.
//
// Two things consume it, and they must not drift apart: the `commit-msg` hook
// that strips these lines as a commit is written, and the CI check that fails a
// pull request carrying one. A trailer the hook misses but CI catches is a
// confusing block; one CI misses but the hook strips is a silent gap.
//
// Matched against whole lines. Each pattern targets an attribution line, not a
// mention — the product names are legitimate elsewhere in this repo, since
// Anodex ships Anthropic and OpenAI providers and their names appear throughout
// `src/` as product surface. A commit body discussing these tools in prose is
// left alone.
export const ATTRIBUTION_PATTERNS = [
  // `Co-Authored-By: Claude <noreply@anthropic.com>` and relatives. Keyed on
  // the tool identity rather than the trailer alone, so a real human
  // co-author trailer still survives.
  /^\s*co-authored-by:.*\b(claude|codex|copilot|cursor|anthropic\.com|openai\.com)\b/i,
  // `🤖 Generated with [Claude Code](...)` and its variants.
  /^\s*(?:🤖\s*)?generated with\b.*\b(claude|codex|copilot|cursor)\b/i,
  // Assorted sign-off shapes seen from agent tooling.
  /^\s*(?:signed-off-by|assisted-by|authored-by):.*\b(claude|codex|copilot|cursor)\b/i
]

/** The attribution lines in a commit message, if any. */
export function attributionLines(message) {
  return message
    .split('\n')
    .filter((line) => ATTRIBUTION_PATTERNS.some((pattern) => pattern.test(line)))
}
