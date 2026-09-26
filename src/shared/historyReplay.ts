import type { ChatHistoryTurn } from './chat.types'

/** A single old answer must not consume the whole model's reading time. */
export const MAX_REPLAY_ASSISTANT_CHARS = 8_000
export const MAX_REPLAY_TOOL_BODY_CHARS_PER_TURN = 8_000
const REPLY_HEAD_CHARS = 1_500
const REPLY_TAIL_CHARS = 6_000

const OMITTED_REPLY = '\n\n[Middle of this older reply omitted from model replay.]\n\n'
const OMITTED_TOOL_BODY = '[older result omitted]'

function replyExcerpt(content: string): string {
  if (content.length <= MAX_REPLAY_ASSISTANT_CHARS) return content
  const headEnd =
    content.charCodeAt(REPLY_HEAD_CHARS - 1) >= 0xd800 &&
    content.charCodeAt(REPLY_HEAD_CHARS - 1) <= 0xdbff
      ? REPLY_HEAD_CHARS - 1
      : REPLY_HEAD_CHARS
  const tailStart = content.length - REPLY_TAIL_CHARS
  const safeTailStart =
    content.charCodeAt(tailStart) >= 0xdc00 && content.charCodeAt(tailStart) <= 0xdfff
      ? tailStart + 1
      : tailStart
  return `${content.slice(0, headEnd)}${OMITTED_REPLY}${content.slice(safeTailStart)}`
}

/**
 * Bound one historical assistant turn independently of the context window.
 * A long task can have hundreds of tool calls in one reply, which otherwise
 * stays verbatim whenever a large context window says it technically fits.
 * One visual follow-up reread 24,555 tokens, spending 38 seconds on the prompt
 * before its first tool call, after a 47,000-character reply with 137 tools.
 * The persisted conversation and visible transcript remain untouched.
 */
export function boundAssistantHistoryReplay(turn: ChatHistoryTurn): ChatHistoryTurn {
  if (turn.role !== 'assistant') return turn

  const content = replyExcerpt(turn.content)
  if (!turn.toolCalls?.length) return content === turn.content ? turn : { ...turn, content }

  let bodyChars = 0
  const toolCalls = [...turn.toolCalls]
  for (let index = toolCalls.length - 1; index >= 0; index--) {
    const call = toolCalls[index]
    const body = call.result ?? call.detail
    if (!body) continue
    if (bodyChars + body.length <= MAX_REPLAY_TOOL_BODY_CHARS_PER_TURN) {
      bodyChars += body.length
      continue
    }
    bodyChars += OMITTED_TOOL_BODY.length
    toolCalls[index] = {
      ...call,
      result: OMITTED_TOOL_BODY,
      detail: undefined
    }
  }
  return { ...turn, content, toolCalls }
}
