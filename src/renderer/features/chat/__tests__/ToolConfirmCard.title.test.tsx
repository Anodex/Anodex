import { describe, expect, it } from 'vitest'
import type { ToolConfirmRequest } from '@shared/tools.types'
import { confirmCardPresentation } from '../confirmCardPresentation'

/**
 * What the approval card calls the thing it is asking you to approve.
 *
 * The header came from the tool's `kind`, and every mutating tool declares
 * `kind: 'write'` — so anything that changes something said "Apply file
 * change?". Seen in the real app while approving a Scheduler deletion: the card
 * was badged DESTRUCTIVE and correctly listed the task, its schedule and its
 * next run, under a header claiming a file was being edited. Nothing about a
 * file was involved.
 *
 * That is not a typo, it is the wording on a destructive confirmation. The
 * person reading it is being told the wrong thing about what they are
 * approving, at the one moment the app asks them to decide.
 *
 * It predates the delete tool: creating a reminder with `schedule_task` has
 * always said it too.
 */

function requestFor(overrides: Partial<ToolConfirmRequest>): ToolConfirmRequest {
  return {
    id: 'c1',
    conversationId: 'conv1',
    messageId: 'm1',
    toolName: 'write_file',
    kind: 'write',
    title: 'Write src/app.ts',
    detail: 'src/app.ts',
    risk: 'sensitive',
    ...overrides
  }
}

describe('confirmCardPresentation', () => {
  it('says a file change is a file change', () => {
    const presentation = confirmCardPresentation(
      requestFor({ diff: { path: 'src/app.ts', before: 'const a = 1\n', after: 'const a = 2\n' } })
    )

    expect(presentation.title).toBe('Apply file change?')
    expect(presentation.approveLabel).toBe('Apply')
  })

  it('names the actual action when the write is not a file change', () => {
    // The case that exposed this: deleting a Scheduler task.
    const presentation = confirmCardPresentation(
      requestFor({
        toolName: 'delete_scheduled_task',
        title: 'Delete scheduled task "Interval test"',
        risk: 'destructive'
      })
    )

    expect(presentation.title).toBe('Delete scheduled task "Interval test"')
  })

  it('does the same for creating a scheduled task, which was always wrong too', () => {
    const presentation = confirmCardPresentation(
      requestFor({ toolName: 'schedule_task', title: 'Schedule "Remind me to stretch"' })
    )

    expect(presentation.title).toBe('Schedule "Remind me to stretch"')
  })

  it('falls back to the file wording rather than showing an empty header', () => {
    // A write with neither a diff nor a usable title is the one case where the
    // generic wording is still the best available answer. An empty header would
    // be worse than an imprecise one.
    expect(confirmCardPresentation(requestFor({ title: '   ' })).title).toBe('Apply file change?')
  })

  it('leaves the other kinds alone', () => {
    // These headers were never wrong: a command is a command whatever tool ran
    // it, and the generic wording is what the card is for.
    expect(confirmCardPresentation(requestFor({ kind: 'command', title: 'npm test' })).title).toBe(
      'Run command?'
    )
    expect(confirmCardPresentation(requestFor({ kind: 'web', title: 'search' })).title).toBe(
      'Search the web?'
    )
    expect(confirmCardPresentation(requestFor({ kind: 'mcp', title: 'mcp' })).title).toBe(
      'Run MCP tool?'
    )
  })

  it('renders an email draft as the send it is', () => {
    // Pre-existing behaviour, pinned so the extraction cannot quietly drop it.
    const withDraft = confirmCardPresentation(
      requestFor({
        toolName: 'reply_email',
        emailDraft: {
          to: ['a@b.c'],
          subject: 'Re: hello',
          body: 'hi',
          inReplyToSubject: 'hello'
        }
      })
    )

    expect(withDraft.title).toBe('Send this reply to "hello"?')
    expect(withDraft.approveLabel).toBe('Send')
  })
})
