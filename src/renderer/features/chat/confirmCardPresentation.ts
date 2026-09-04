import type { ToolConfirmRequest } from '@shared/tools.types'

/**
 * How an approval card introduces itself: icon, colour, header, approve button.
 *
 * Extracted from `ToolConfirmCard` because the header was wrong and the reason
 * was not visible inline. Every mutating tool declares `kind: 'write'`, and the
 * header was chosen from `kind` alone, so anything that changed anything said
 * "Apply file change?". Observed in the running app while approving a Scheduler
 * deletion: the card was badged DESTRUCTIVE and correctly listed the task, its
 * schedule and its next run, under a header claiming a file was being edited.
 *
 * That is the wording on a destructive confirmation, at the one moment the app
 * asks someone to decide, so it is worth more than a constant.
 */
export interface ConfirmCardPresentation {
  icon: 'copy' | 'terminal' | 'web' | 'plug' | 'send'
  style: 'write' | 'command' | 'web' | 'mcp' | 'draft'
  title: string
  approveLabel: string
}

const DRAFT_CONFIG = {
  icon: 'send',
  style: 'draft',
  approveLabel: 'Send'
} as const

const KIND_CONFIG: Record<
  ToolConfirmRequest['kind'],
  Omit<ConfirmCardPresentation, 'title'> & { title: string }
> = {
  write: { icon: 'copy', style: 'write', title: 'Apply file change?', approveLabel: 'Apply' },
  command: { icon: 'terminal', style: 'command', title: 'Run command?', approveLabel: 'Run' },
  mcp: { icon: 'plug', style: 'mcp', title: 'Run MCP tool?', approveLabel: 'Run' },
  web: { icon: 'web', style: 'web', title: 'Search the web?', approveLabel: 'Search' }
}

export function confirmCardPresentation(request: ToolConfirmRequest): ConfirmCardPresentation {
  const draft = request.emailDraft
  if (draft) {
    return {
      ...DRAFT_CONFIG,
      title: draft.inReplyToSubject
        ? `Send this reply to "${draft.inReplyToSubject}"?`
        : 'Send this email?'
    }
  }

  const config = KIND_CONFIG[request.kind]

  /**
   * A file change carries a before/after so the card can render a real diff; a
   * write that changes something else never does.
   *
   * Keyed on that rather than on a list of file-tool names, because a list has
   * to be remembered: the next tool with `kind: 'write'` would inherit the file
   * wording by default and nobody would notice, which is exactly how a Scheduler
   * deletion came to announce itself as a file edit. The request's own title
   * already says what the call does, so there is nothing to invent.
   */
  const isFileChange = request.diff !== undefined
  if (request.kind !== 'write' || isFileChange) return config

  const own = request.title.trim()
  // An imprecise header beats an empty one, so the generic wording stays as the
  // fallback for a write that supplied no usable title.
  return own.length > 0 ? { ...config, title: own } : config
}
