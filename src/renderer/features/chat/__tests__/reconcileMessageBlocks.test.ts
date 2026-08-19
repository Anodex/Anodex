import { describe, expect, it } from 'vitest'
import type { MessageBlock } from '@shared/chat.types'
import type { ToolCall } from '@shared/tools.types'
import { reconcileMessageBlocks } from '../reconcileMessageBlocks'

function call(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tool-1',
    name: 'read_file',
    kind: 'read',
    title: 'Read src/App.tsx',
    status: 'success',
    ...overrides
  }
}

describe('reconcileMessageBlocks', () => {
  it('strips streamed raw tool-call JSON while preserving the tool card position', () => {
    const tool = call()
    const blocks: MessageBlock[] = [
      {
        type: 'text',
        text:
          "I'll inspect the file.\n\n```json\n" +
          '{"name": "read_file", "arguments": {"path": "src/App.tsx"}}\n```'
      },
      { type: 'tool', call: tool },
      { type: 'text', text: 'The issue is in the imports.' }
    ]

    expect(
      reconcileMessageBlocks(blocks, "I'll inspect the file.\n\nThe issue is in the imports.", [
        tool
      ])
    ).toEqual([
      { type: 'text', text: "I'll inspect the file." },
      { type: 'tool', call: tool },
      { type: 'text', text: 'The issue is in the imports.' }
    ])
  })

  it('does not strip JSON examples for tools that were not actually called', () => {
    const exampleText =
      'A tool payload would look like:\n\n```json\n' +
      '{"name": "read_file", "arguments": {"path": "src/App.tsx"}}\n```'
    const blocks: MessageBlock[] = [
      {
        type: 'text',
        text: exampleText
      }
    ]

    expect(reconcileMessageBlocks(blocks, exampleText, undefined)).toEqual([
      { type: 'text', text: exampleText }
    ])
  })

  it('falls back to final content when raw tool text was the whole streamed text', () => {
    const tool = call()
    const blocks: MessageBlock[] = [
      {
        type: 'text',
        text: '<tool_call>{"name": "read_file", "arguments": {"path": "src/App.tsx"}}</tool_call>'
      },
      { type: 'tool', call: tool }
    ]

    expect(reconcileMessageBlocks(blocks, 'Done.', [tool])).toEqual([
      { type: 'tool', call: tool },
      { type: 'text', text: 'Done.' }
    ])
  })

  it('can strip known tool payloads even when the call did not complete', () => {
    const blocks: MessageBlock[] = [
      {
        type: 'text',
        text:
          'Let me verify that.\n\n```json\n' +
          '{"name": "read_file", "arguments": {"path": "src/App.tsx"}}\n```'
      }
    ]

    expect(reconcileMessageBlocks(blocks, 'Let me verify that.', undefined, ['read_file'])).toEqual(
      [{ type: 'text', text: 'Let me verify that.' }]
    )
  })

  it('preserves thinking blocks through the no-tools shortcut instead of discarding them', () => {
    const blocks: MessageBlock[] = [
      { type: 'thinking', text: 'Let me consider the options...' },
      { type: 'text', text: 'partial streamed text' }
    ]

    expect(reconcileMessageBlocks(blocks, 'The final answer.', undefined)).toEqual([
      { type: 'thinking', text: 'Let me consider the options...' },
      { type: 'text', text: 'The final answer.' }
    ])
  })

  it('passes thinking blocks through untouched when tools were called too', () => {
    const tool = call()
    const blocks: MessageBlock[] = [
      { type: 'thinking', text: 'I should check the file first.' },
      { type: 'tool', call: tool },
      { type: 'thinking', text: 'Now I can answer.' },
      { type: 'text', text: 'The issue is in the imports.' }
    ]

    expect(reconcileMessageBlocks(blocks, 'The issue is in the imports.', [tool])).toEqual(blocks)
  })

  // A turn that stopped mid-work rendered with no account of itself at all:
  // the account is appended to `content` in the main process, never streams,
  // and so exists in no live block. This path keeps the streamed blocks, so
  // without re-attaching it the user saw the reply simply stop.
  it('re-attaches the turn account when streamed text blocks are kept', () => {
    const tool = call()
    const outcome = '\n\n---\n**What this reply did**\n\n- **Changed** `a.js`'
    const blocks: MessageBlock[] = [
      { type: 'text', text: 'Let me fix that now:' },
      { type: 'tool', call: tool }
    ]

    expect(
      reconcileMessageBlocks(
        blocks,
        `Let me fix that now:${outcome}`,
        [tool],
        [],
        '',
        false,
        outcome
      )
    ).toEqual([...blocks, { type: 'text', text: outcome }])
  })

  it('does not duplicate the turn account when it falls back to the final content', () => {
    const tool = call()
    const outcome = '\n\n---\n**What this reply did**\n\n- **Changed** `a.js`'
    const blocks: MessageBlock[] = [{ type: 'tool', call: tool }]

    expect(
      reconcileMessageBlocks(blocks, `All done.${outcome}`, [tool], [], '', false, outcome)
    ).toEqual([...blocks, { type: 'text', text: `All done.${outcome}` }])
  })
})
