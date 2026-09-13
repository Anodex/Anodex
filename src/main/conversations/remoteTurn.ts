import type { ChatMessage, ChatRequest } from '@shared/chat.types'
import type { Conversation } from '@shared/conversation.types'
import { firstPlainLine } from '@shared/titleText'
import type { RunGenerationResult } from '../chat/runGeneration'
import { carriesNothing } from './backgroundTurn'

/** The fallback title's length, matching what the phone writes for a new chat. */
const MAX_TITLE_CHARS = 60

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
  result: Pick<RunGenerationResult, 'content' | 'stats' | 'thinking'> & {
    stopReason?: RunGenerationResult['stopReason']
  },
  now: number
): Conversation | null {
  const reply: ChatMessage = {
    id: `${request.messageId}:reply`,
    role: 'assistant',
    content: result.content,
    createdAt: now,
    stats: result.stats,
    ...(result.thinking ? { thinking: result.thinking } : {})
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
      updatedAt: now,
      messages: [question, reply]
    }
  }

  return {
    id: request.conversationId,
    projectId: request.projectId ?? null,
    title: titleFrom(request.prompt),
    createdAt: now,
    updatedAt: now,
    messages: [question, reply]
  }
}

function titleFrom(prompt: string): string {
  const line = firstPlainLine(prompt)
  if (!line) return 'New chat'
  return line.length > MAX_TITLE_CHARS ? `${line.slice(0, MAX_TITLE_CHARS).trimEnd()}…` : line
}
