import { describe, expect, it } from 'vitest'
import type { ChatMessage, MessageBlock } from '@shared/chat.types'
import type { Conversation } from '@shared/conversation.types'
import { messageToHistoryTurn, sanitizeConversationTranscript } from '@shared/chatSanitizer'
import { estimateProjectedContextUsage } from '@shared/contextProjection'
import { buildHistoryItems } from '../LlamaService'
import { projectHistoryForModel, seedContextFromSnapshot } from '../contextAssembler'

const RAW_EDIT_PAYLOAD =
  '{"name":"edit_file","arguments":{"path":"tic-tac-toe.css","oldText":"body { background:#fff; }","newText":"body { background:#282c34; }"}}'

const RAW_PATCH_PAYLOAD =
  '{"name":"patch_file","arguments":{"path":"tic-tac-toe.css","replacements":[{"oldText":"cursor: pointer;","newText":"cursor: pointer; transition: transform 0.2s;"}]}}'

const RAW_MARKERS = [
  '"arguments"',
  '"oldText"',
  '"newText"',
  'body { background:#fff; }',
  'transition: transform 0.2s;'
]

describe('tic-tac-toe chat transcript regression', () => {
  it('keeps raw model-printed tool JSON out of saved text, projected context, and replay', () => {
    const transcript = ticTacToeFailureTranscript()
    const sanitized = sanitizeConversationTranscript(transcript)

    expect(sanitized.changed).toBe(true)
    expect(allAssistantText(sanitized.conversation.messages)).not.toContain(RAW_EDIT_PAYLOAD)
    expect(allAssistantText(sanitized.conversation.messages)).not.toContain(RAW_PATCH_PAYLOAD)
    expect(sanitized.conversation.messages[1].toolCalls?.[0]).toMatchObject({
      name: 'edit_file',
      status: 'error'
    })

    const history = sanitized.conversation.messages.map(messageToHistoryTurn)
    const seeded = seedContextFromSnapshot('be concise', history, sanitized.conversation.context)
    const projected = projectHistoryForModel(seeded.history)
    const replay = buildHistoryItems(seeded.systemPrompt, projected)
    const replayText = JSON.stringify(replay)

    expect(seeded.applied).toBe(true)
    expect(projected).toHaveLength(2)
    expect(projected[0]).toMatchObject({ id: 'm3', role: 'assistant' })
    expect(replayText).toContain('"type":"functionCall"')
    expect(replayText).toContain('"name":"read_file"')

    for (const marker of RAW_MARKERS) {
      expect(replayText).not.toContain(marker)
    }
  })

  it('estimates context pressure from the cleaned transcript instead of raw leaked payloads', () => {
    const { conversation } = sanitizeConversationTranscript(ticTacToeFailureTranscript())

    const usage = estimateProjectedContextUsage({
      conversation,
      contextSize: 2_000,
      systemPrompt: 'be concise'
    })

    expect(usage.snapshotApplied).toBe(true)
    expect(usage.snapshotTurns).toBe(2)
    // The post-boundary assistant/tool messages are one active interaction in
    // the ledger projection, so they remain together even under pressure.
    expect(usage.recentTurns).toBe(2)
    expect(usage.omittedTurns).toBe(0)
    expect(usage.totalTurns).toBe(4)
  })
})

function ticTacToeFailureTranscript(): Conversation {
  // Synthetic reproduction of the chat failure where the model printed tool JSON
  // into assistant text before the structured tool block was reconciled.
  return {
    id: 'c_tic_tac_toe_regression',
    projectId: 'p_tic_tac_toe',
    title: 'Tic tac toe styling',
    createdAt: 1,
    updatedAt: 4,
    context: {
      activeSnapshot: {
        id: 'ctx_tic_tac_toe_regression',
        createdAt: 5,
        reason: 'manual',
        throughMessageId: 'm2',
        removedTurns: 2,
        summary:
          'The user asked Anodex to improve a tic-tac-toe page. The assistant attempted an edit, but the exact replacement text was not found.'
      }
    },
    messages: [
      {
        id: 'm1',
        role: 'user',
        content: 'add more design to it to make it look better it looks very basic',
        createdAt: 1
      },
      assistantMessage({
        id: 'm2',
        content: `Sure, I will enhance the design and update the CSS.\n${RAW_EDIT_PAYLOAD}`,
        blocks: [
          {
            type: 'text',
            text: `Sure, I will enhance the design and update the CSS.\n${RAW_EDIT_PAYLOAD}`
          },
          {
            type: 'tool',
            call: {
              id: 't1',
              name: 'edit_file',
              kind: 'write',
              title: 'Edit tic-tac-toe.css',
              status: 'error',
              detail: 'The text to replace was not found in the file.'
            }
          }
        ],
        createdAt: 2,
        toolCalls: [
          {
            id: 't1',
            name: 'edit_file',
            kind: 'write',
            title: 'Edit tic-tac-toe.css',
            status: 'error',
            detail: 'The text to replace was not found in the file.'
          }
        ]
      }),
      assistantMessage({
        id: 'm3',
        content:
          'The replacement missed the current file. I will inspect it first, then patch only matching text.',
        blocks: [
          {
            type: 'text',
            text: 'The replacement missed the current file. I will inspect it first, then patch only matching text.'
          },
          {
            type: 'tool',
            call: {
              id: 't2',
              name: 'read_file',
              kind: 'read',
              title: 'Read tic-tac-toe.css',
              status: 'success',
              result: 'body { display:flex; }\n.cell { cursor: pointer; }'
            }
          }
        ],
        createdAt: 3,
        toolCalls: [
          {
            id: 't2',
            name: 'read_file',
            kind: 'read',
            title: 'Read tic-tac-toe.css',
            status: 'success',
            result: 'body { display:flex; }\n.cell { cursor: pointer; }'
          }
        ]
      }),
      assistantMessage({
        id: 'm4',
        content: `I found the current CSS and will apply a focused patch.\n\`\`\`json\n${RAW_PATCH_PAYLOAD}\n\`\`\``,
        blocks: [
          {
            type: 'text',
            text: `I found the current CSS and will apply a focused patch.\n\`\`\`json\n${RAW_PATCH_PAYLOAD}\n\`\`\``
          }
        ],
        createdAt: 4
      })
    ]
  }
}

function assistantMessage({
  id,
  content,
  blocks,
  createdAt,
  toolCalls
}: {
  id: string
  content: string
  blocks: MessageBlock[]
  createdAt: number
  toolCalls?: ChatMessage['toolCalls']
}): ChatMessage {
  return {
    id,
    role: 'assistant',
    content,
    blocks,
    toolCalls,
    createdAt
  }
}

function allAssistantText(messages: ChatMessage[]): string {
  return messages
    .flatMap((message) => {
      if (message.role !== 'assistant') return []
      const blockText = (message.blocks ?? [])
        .filter((block): block is Extract<MessageBlock, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
      return [message.content, ...blockText]
    })
    .join('\n')
}
