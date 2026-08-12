import type { IconName } from '../components/Icon'

export type SlashCommandName =
  'goal' | 'continue' | 'plan' | 'next' | 'test' | 'review' | 'refactor' | 'summarize'

interface SlashCommandSpec {
  label: string
  description: string
  prompt: string
  icon: IconName
}

export interface SlashCommandSuggestion {
  name: SlashCommandName
  label: string
  description: string
  icon: IconName
}

/** Icon reserved for user-defined shortcuts when custom slash commands ship. */
export const CUSTOM_SLASH_COMMAND_ICON: IconName = 'slash-custom'

const SLASH_COMMANDS: Record<SlashCommandName, SlashCommandSpec> = {
  goal: {
    label: 'Set goal',
    description: 'Create a focused goal and visible work plan.',
    icon: 'slash-goal',
    prompt:
      'Set a focused goal for this task, create or update a concise visible plan, then begin the first unfinished step.'
  },
  continue: {
    label: 'Continue work',
    description: 'Resume from the latest completed work.',
    icon: 'slash-continue',
    prompt:
      'Continue the current task from the latest completed work. Reuse the visible plan and real tool results; do not repeat completed steps.'
  },
  plan: {
    label: 'Review plan',
    description: 'Review the current plan and next unfinished step.',
    icon: 'slash-plan',
    prompt:
      'Review the current visible plan. Mark only verified completed steps complete, identify the next unfinished step, and continue if it is clear.'
  },
  next: {
    label: 'Do next step',
    description: 'Carry out the next useful task action.',
    icon: 'slash-next',
    prompt:
      'Identify the next unfinished plan step or most useful next action, then carry it out. Do not repeat work already completed.'
  },
  test: {
    label: 'Run tests',
    description: 'Find and run the most relevant tests.',
    icon: 'slash-test',
    prompt:
      'Run the most relevant tests for the current change. If there is no obvious narrow target, run the closest reasonable test suite. Summarize any failures with file names and likely causes.'
  },
  review: {
    label: 'Review code',
    description: 'Review the current code or diff for issues.',
    icon: 'slash-review',
    prompt:
      'Review the current code or diff like a careful pull request reviewer. Focus on bugs, regressions, missing tests, and maintainability.'
  },
  refactor: {
    label: 'Refactor',
    description: 'Improve clarity without changing behavior.',
    icon: 'slash-refactor',
    prompt:
      'Refactor the current code for clarity and maintainability without changing behavior. Explain any behavior-preserving changes and mention tests to run.'
  },
  summarize: {
    label: 'Summarize',
    description: 'Summarize the chat or workspace state.',
    icon: 'slash-summarize',
    prompt:
      'Summarize the current conversation or workspace state clearly and compactly. Capture decisions, open questions, and next steps.'
  }
}

const SLASH_COMMAND_ORDER: SlashCommandName[] = [
  'goal',
  'continue',
  'plan',
  'next',
  'test',
  'review',
  'refactor',
  'summarize'
]

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

function toSuggestion(name: SlashCommandName): SlashCommandSuggestion {
  const command = SLASH_COMMANDS[name]
  return {
    name,
    label: command.label,
    description: command.description,
    icon: command.icon
  }
}

/** Return matching commands while the composer contains only an uninterrupted slash prefix. */
export function getSlashCommandSuggestions(text: string): SlashCommandSuggestion[] {
  const match = /^\/([^\s]*)$/.exec(text)
  if (!match) return []

  const query = match[1].toLowerCase()
  return SLASH_COMMAND_ORDER.filter((name) => name.startsWith(query)).map(toSuggestion)
}

/** Complete the typed slash prefix with a selected command, ready for optional user context. */
export function completeSlashCommand(_text: string, command: SlashCommandName): string {
  return `/${command} `
}
