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

    expect(reconcileMessageBlocks(blocks, "I'll inspect the file.\n\nThe issue is in the imports.", [
      tool
    ])).toEqual([
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

    expect(reconcileMessageBlocks(blocks, 'Let me verify that.', undefined, ['read_file'])).toEqual([
      { type: 'text', text: 'Let me verify that.' }
    ])
  })
})
