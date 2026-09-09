import type { Conversation } from '@shared/conversation.types'
import type { ChatMessage, MessagePersona } from '@shared/chat.types'

/**
 * How much of a transcript may be sent to a phone in one reply.
 *
 * `MAX_RESPONSE_BYTES` in the remote protocol refuses anything over 4MB outright,
 * because a WebSocket message is buffered whole by the client and an oversized one
 * is an uncatchable `OutOfMemoryError` rather than a slow load. That guard works —
 * it was refusing 6MB conversations, and correctly. What it could not do is make
 * those conversations openable: the phone asked, the desktop refused, and the chat
 * simply would not open, with no way to reach it from away at all.
 *
 * Half the ceiling, so the envelope, the conversation's own fields and any headroom
 * the encoder wants are never what pushes a reply over.
 */
export const REMOTE_TRANSCRIPT_BYTES = 2 * 1024 * 1024

/**
 * How much of a single turn may be sent.
 *
 * One reply can be the whole problem on its own — a model asked for a complete HTML
 * page answers with one. Dropping that turn would leave a hole in the middle of a
 * conversation with no explanation; sending it whole is what the ceiling forbids. So
 * it is cut, and says that it was cut.
 *
 * A hundred and twenty-eight kilobytes is around twenty thousand words, which is far
 * more than anybody reads on a phone and still leaves room for a dozen such turns.
 */
export const REMOTE_MESSAGE_BYTES = 128 * 1024

/** A turn, in the four fields the phone actually reads. */
export interface RemoteMessage {
  id: string
  role: ChatMessage['role']
  content: string
  persona?: MessagePersona
}

/** A conversation, as much of it as will fit. */
export interface RemoteConversation {
  id: string
  projectId: string | null
  title: string
  createdAt: number
  updatedAt: number
  archived?: boolean
  messages: RemoteMessage[]
  /**
   * True when this is not the whole conversation — turns were dropped from the
   * start of it, or one was cut short.
   */
  partial: boolean
}

/**
 * A conversation cut down to what a phone asked for and can survive.
 *
 * Built up from the fields the phone reads rather than by subtracting the ones it
 * does not, which is the difference between a rule that holds and one that lasts
 * until somebody adds another heavy field. A `ChatMessage` carries tool calls,
 * render blocks, context assemblies, generation stats, memory entries and
 * attachments; a `Conversation` carries plans, goals, context ledgers and visual
 * previews. The phone parses `id`, `role`, `content` and `persona`, and renders
 * nothing else. On an agent transcript that difference is most of the bytes.
 *
 * Then a budget on top, because text alone can still be too much: newest turns
 * first, stopping when the next one would not fit. The newest are kept because the
 * end of a conversation is the part somebody is coming back to — the same reason
 * `conversations:get` takes its limit from the tail.
 */
export function forRemote(
  conversation: Conversation,
  budgetBytes: number = REMOTE_TRANSCRIPT_BYTES,
  perMessageBytes: number = REMOTE_MESSAGE_BYTES
): RemoteConversation {
  const kept: RemoteMessage[] = []
  let used = 0
  let dropped = 0
  let cut = false

  for (let index = conversation.messages.length - 1; index >= 0; index--) {
    const { message, wasCut } = trim(conversation.messages[index], perMessageBytes)
    const size = byteLength(JSON.stringify(message))

    // Always at least one turn, even if that one turn is over budget on its own.
    // A conversation that opens on its last reply is worth more than one that
    // refuses to open.
    if (kept.length > 0 && used + size > budgetBytes) {
      dropped = index + 1
      break
    }

    used += size
    cut = cut || wasCut
    kept.push(message)
  }

  kept.reverse()

  return {
    id: conversation.id,
    projectId: conversation.projectId,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    archived: conversation.archived,
    messages: kept,
    partial: cut || dropped > 0
  }
}

/** One turn, reduced to what is read, and shortened if it is still too long. */
function trim(
  message: ChatMessage,
  perMessageBytes: number
): { message: RemoteMessage; wasCut: boolean } {
  const full = message.content ?? ''
  const size = byteLength(full)

  if (size <= perMessageBytes) {
    return {
      message: {
        id: message.id,
        role: message.role,
        content: full,
        ...(message.persona ? { persona: message.persona } : {})
      },
      wasCut: false
    }
  }

  // Characters are not bytes. Slicing to the byte budget can still overshoot by up
  // to four times on non-Latin text, so the result is measured and cut again rather
  // than assumed — the whole point of this file is that one oversized value must not
  // be able to break the reply.
  let head = full.slice(0, perMessageBytes)
  while (byteLength(head) > perMessageBytes && head.length > 0) {
    head = head.slice(0, Math.floor(head.length / 2))
  }

  const trimmedKb = Math.round((size - byteLength(head)) / 1024)

  return {
    message: {
      id: message.id,
      role: message.role,
      content: `${head}\n\n… ${trimmedKb}KB more. Open this conversation on the computer to read the rest.`,
      ...(message.persona ? { persona: message.persona } : {})
    },
    wasCut: true
  }
}

const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8')
