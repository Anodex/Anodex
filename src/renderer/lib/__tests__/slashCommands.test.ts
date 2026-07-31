import { describe, expect, it } from 'vitest'
import {
  completeSlashCommand,
  expandSlashCommand,
  getSlashCommandSuggestions
} from '../slashCommands'

describe('expandSlashCommand', () => {
  it('expands /test into a reusable test prompt', () => {
    expect(expandSlashCommand('/test')).toEqual({
      command: 'test',
      expandedText:
        'Run the most relevant tests for the current change. If there is no obvious narrow target, run the closest reasonable test suite. Summarize any failures with file names and likely causes.'
    })
  })

  it('preserves extra user context after the slash shortcut', () => {
    expect(expandSlashCommand('/review focus on the sidebar')).toEqual({
      command: 'review',
      expandedText:
        'Review the current code or diff like a careful pull request reviewer. Focus on bugs, regressions, missing tests, and maintainability.\n\nAdditional context from the user:\nfocus on the sidebar'
    })
  })

  it('ignores unknown slash commands', () => {
    expect(expandSlashCommand('/unknown do something')).toBeNull()
  })

  it('ignores ordinary messages', () => {
    expect(expandSlashCommand('please summarize this')).toBeNull()
  })
})

describe('getSlashCommandSuggestions', () => {
  it('returns all commands when the user starts a slash command', () => {
    expect(getSlashCommandSuggestions('/').map((command) => command.name)).toEqual([
      'test',
      'review',
      'refactor',
      'summarize'
    ])
  })

  it('filters commands by the typed slash prefix', () => {
    expect(getSlashCommandSuggestions('/re').map((command) => command.name)).toEqual([
      'review',
      'refactor'
    ])
  })

  it('does not show suggestions once the user adds command arguments', () => {
    expect(getSlashCommandSuggestions('/review current diff')).toEqual([])
  })

  it('does not show suggestions for ordinary messages', () => {
    expect(getSlashCommandSuggestions('please /review')).toEqual([])
  })
})

describe('completeSlashCommand', () => {
  it('replaces the typed prefix with the selected slash command and a trailing space', () => {
    expect(completeSlashCommand('/re', 'review')).toBe('/review ')
  })
})
