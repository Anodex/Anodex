import type { Conversation } from './conversation.types'
import type { ChatMessage } from './chat.types'

/**
 * Rendering a conversation into something that outlives Anodex.
 *
 * A local-first app that can't hand your own words back in a portable format
 * is holding them hostage by accident. Markdown is the readable form; the raw
 * `Conversation` JSON is the lossless one, and needs no rendering at all.
 *
 * Pure and shared: no filesystem, no Electron. The main process picks the
 * destination and writes; this only decides what the bytes say.
 */

/** Filesystem-safe, reasonably short filename stem for a conversation. */
export function exportFileStem(conversation: Pick<Conversation, 'title' | 'updatedAt'>): string {
  const date = new Date(conversation.updatedAt).toISOString().slice(0, 10)
  const title = conversation.title
    .trim()
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 60)
    .replace(/-+$/, '')
  return title ? `${date}-${title}` : date
}

function roleHeading(message: ChatMessage): string {
  if (message.role === 'user') return 'You'
  if (message.role === 'assistant') return 'Anodex'
  return message.role
}

/**
 * Render a conversation as Markdown.
 *
 * Tool calls are summarised as a single line each rather than dumped in full:
 * a transcript is a record of the conversation, and a raw tool payload is
 * neither readable nor reliably meaningful outside the run that produced it.
 * Anyone who needs that has the JSON export, which keeps everything.
 */
export function conversationToMarkdown(conversation: Conversation): string {
  const lines: string[] = []
  lines.push(`# ${conversation.title}`)
  lines.push('')
  lines.push(`_Exported from Anodex on ${new Date().toISOString().slice(0, 10)}_`)
  lines.push('')

  for (const message of conversation.messages) {
    const content = message.content.trim()
    const toolCalls = message.toolCalls ?? []
    if (!content && toolCalls.length === 0) continue

    lines.push(`## ${roleHeading(message)}`)
    lines.push('')
    if (content) {
      lines.push(content)
      lines.push('')
    }
    for (const call of toolCalls) {
      const detail = call.detail?.trim()
      lines.push(`- \`${call.name}\`${detail ? ` — ${detail.split('\n')[0]}` : ''}`)
    }
    if (toolCalls.length > 0) lines.push('')
  }

  // Exactly one trailing newline, so appending or diffing the file behaves.
  return `${lines.join('\n').trimEnd()}\n`
}
