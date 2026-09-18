import type { ChatMessage, ChatRequest } from '@shared/chat.types'
import type { Conversation } from '@shared/conversation.types'
import { firstPlainLine } from '@shared/titleText'
import type { RunGenerationResult } from '../chat/runGeneration'
import { carriesNothing } from './backgroundTurn'

/** What an empty conversation is called until its first turn. */
const PLACEHOLDER_TITLE = 'New chat'

/** The fallback title's length, matching what the phone writes for a new chat. */
const MAX_TITLE_CHARS = 60

/**
 * Which project a turn belongs to, by the same rule the run itself uses.
 *
 * The distinction is between a key that is absent and one that is null, and it
 * is deliberate: absent means "whatever project is open at the computer", null
 * means "none". `boundedChatRunner` has honoured that for as long as it has
 * existed. This file did not — it read `request.projectId ?? null`, which
 * collapses the two — so a turn from a client that omits the key *ran* inside the
 * active project and was *filed* under no project at all. The work happened in
 * one place and the record of it went to another, and nothing failed.
 *
 * Passed in rather than read from `projectStore` here, so this stays a pure
 * function over a request and its caller keeps deciding what "active" means.
 */
export function projectForRemoteTurn(
  request: Pick<ChatRequest, 'projectId'>,
  activeProjectId: string | null
): string | null {
  return 'projectId' in request ? (request.projectId ?? null) : activeProjectId
}

/**
 * A phone's finished turn, as the conversation the computer should now hold.
 *
 * The phone used to be the only thing that saved a turn it sent. It writes the
 * conversation back once `chat:send` answers — so when it stopped waiting first, the
 * reply the computer went on to finish was written nowhere. Seen on a real phone: a
 * question sent while an agent run held the model, a "went quiet for 5 minutes"
 * banner, and afterwards no trace of the conversation on either device.
 *
 * So the computer records the turn itself when it finishes, whoever is still
 * listening. The phone still saves as it always has; both writes are remote-style
 * merges keyed on message id, so whichever lands second adds only what the first
 * lacked. Ids follow the phone's scheme — the request's `messageId` for the question,
 * with `:reply` appended for the answer — which is what makes the two agree.
 *
 * Returns null when there is nothing worth writing: an answer that carries nothing
 * at all, which the transcript gains nothing from.
 */
export function remoteTurnConversation(
  existing: Conversation | null | undefined,
  request: ChatRequest,
  result: Pick<RunGenerationResult, 'content' | 'stats' | 'thinking' | 'checkpoint'> & {
    stopReason?: RunGenerationResult['stopReason']
  },
  now: number,
  /** The project open at the computer, for a request that names none. */
  activeProjectId: string | null = null
): Conversation | null {
  const reply: ChatMessage = {
    id: `${request.messageId}:reply`,
    role: 'assistant',
    content: result.content,
    createdAt: now,
    stats: result.stats,
    ...(result.thinking ? { thinking: result.thinking } : {}),
    // Which files the turn changed. Without it the window drew no Review button for a
    // phone's turn and no Open in browser, though the checkpoint was saved — seen when
    // the same edit sent from the window offered both and the phone's offered neither.
    ...(result.checkpoint?.changedFiles.length ? { checkpoint: result.checkpoint } : {})
  }
  if (carriesNothing(reply)) return null

  // No attachments here, deliberately. The request carries only a name and a path,
  // and a record written from that would be the one that stuck: the store keeps the
  // first copy of a turn and only fills gaps from later ones. Left out, the phone's
  // own save — which knows the size and the kind — supplies them.
  const question: ChatMessage = {
    id: request.messageId,
    role: 'user',
    content: request.prompt,
    createdAt: now
  }

  if (existing) {
    return {
      ...existing,
      // An empty chat made at the desk reads "New chat" until its first turn, which the
      // window replaces when it sends one. A first turn sent from a phone kept it.
      ...(existing.title === PLACEHOLDER_TITLE && existing.messages.length === 0
        ? { title: titleFrom(request.prompt) }
        : {}),
      updatedAt: now,
      messages: [question, reply]
    }
  }

  return {
    id: request.conversationId,
    projectId: projectForRemoteTurn(request, activeProjectId),
    title: titleFrom(request.prompt),
    createdAt: now,
    updatedAt: now,
    messages: [question, reply]
  }
}

/**
 * A phone's new conversation as it starts: the question, before any answer.
 *
 * The computer used to write a phone's turn only once it finished, so for as long as
 * the first reply was being written the conversation existed nowhere but in the
 * phone's memory. When the phone app restarted in that time — installing an update
 * does it — a notification that the turn needed an approval opened "It is not on your
 * computer any more", and the approval could not be answered from the phone. The
 * window, which writes its own question before it asks, never had the problem, and
 * did not show the phone's conversation until it was done.
 *
 * Null for a conversation that already exists: its turns arrive through the phone's
 * save and `remoteTurnConversation` as before.
 */
export function remoteQuestionConversation(
  existing: Conversation | null | undefined,
  request: ChatRequest,
  now: number,
  /** The project open at the computer, for a request that names none. */
  activeProjectId: string | null = null
): Conversation | null {
  if (existing) return null
  return {
    id: request.conversationId,
    projectId: projectForRemoteTurn(request, activeProjectId),
    title: titleFrom(request.prompt),
    createdAt: now,
    updatedAt: now,
    messages: [{ id: request.messageId, role: 'user', content: request.prompt, createdAt: now }]
  }
}

function titleFrom(prompt: string): string {
  const line = firstPlainLine(prompt)
  if (!line) return 'New chat'
  return line.length > MAX_TITLE_CHARS ? `${line.slice(0, MAX_TITLE_CHARS).trimEnd()}…` : line
}
