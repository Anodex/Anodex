import type { ChatMessage, ChatUserFile } from '@shared/chat.types'
import { isAbsoluteAttachmentPath, type ComposerAttachment } from '../../lib/attachments'

/**
 * Most recent this many files. A cap exists because this rides along on every
 * turn, and a long chat full of attachments would otherwise grow the request
 * without bound — while the file anyone means by "send that one" is
 * overwhelmingly among the last few.
 */
const MAX_USER_FILES = 20

/**
 * Every file the user has put into this conversation, newest first.
 *
 * Walks the whole transcript, not just the turn being sent, because attaching
 * a picture and asking about it, then saying "send that" a turn later, is the
 * ordinary way this comes up — and by then the attachment belongs to a message
 * further back.
 *
 * Relative paths are dropped: attachments recorded before paths were stored
 * absolutely can't be located from the main process, and a path that does not
 * resolve is worse than an absent one, because the model would offer to send a
 * file that isn't there.
 */
export function conversationUserFiles(
  messages: ChatMessage[],
  pending: ComposerAttachment[] = []
): ChatUserFile[] {
  const files: ChatUserFile[] = []
  const seen = new Set<string>()

  const add = (name: string, path: string): void => {
    if (!isAbsoluteAttachmentPath(path) || seen.has(path)) return
    seen.add(path)
    files.push({ name, path })
  }

  // The turn being sent comes first: when the user attaches a new copy of a
  // file they already sent earlier, "the one I just attached" is what they
  // mean, and it wins the deduplication.
  for (const attachment of pending) add(attachment.name, attachment.path)

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    for (const attachment of messages[index].attachments ?? []) {
      add(attachment.name, attachment.path)
      if (files.length >= MAX_USER_FILES) return files
    }
  }

  return files.slice(0, MAX_USER_FILES)
}
