export type SlashCommandName = 'test' | 'review' | 'refactor' | 'summarize'

interface SlashCommandSpec {
  prompt: string
}

const SLASH_COMMANDS: Record<SlashCommandName, SlashCommandSpec> = {
  test: {
    prompt:
      'Run the most relevant tests for the current change. If there is no obvious narrow target, run the closest reasonable test suite. Summarize any failures with file names and likely causes.'
  },
  review: {
    prompt:
      'Review the current code or diff like a careful pull request reviewer. Focus on bugs, regressions, missing tests, and maintainability.'
  },
  refactor: {
    prompt:
      'Refactor the current code for clarity and maintainability without changing behavior. Explain any behavior-preserving changes and mention tests to run.'
  },
  summarize: {
    prompt:
      'Summarize the current conversation or workspace state clearly and compactly. Capture decisions, open questions, and next steps.'
  }
}

export interface SlashCommandExpansion {
  command: SlashCommandName
  expandedText: string
}

function isSlashCommandName(value: string): value is SlashCommandName {
  return value in SLASH_COMMANDS
}

/** Expand a built-in slash shortcut into a longer prompt, if the input starts with one. */
export function expandSlashCommand(text: string): SlashCommandExpansion | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null

  const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/.exec(trimmed)
  if (!match) return null

  const command = match[1]
  if (!isSlashCommandName(command)) return null

  const remainder = match[2]?.trim()
  const expandedText = remainder
    ? `${SLASH_COMMANDS[command].prompt}\n\nAdditional context from the user:\n${remainder}`
    : SLASH_COMMANDS[command].prompt

  return {
    command,
    expandedText
  }
}

export const SLASH_COMMAND_HINT = 'Shortcuts: /test, /review, /refactor, /summarize'
