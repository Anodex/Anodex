import { describe, expect, it } from 'vitest'
import type { ChatMessage, MessageBlock } from '@shared/chat.types'
import type { ToolCall } from '@shared/tools.types'
import {
  buildRenderSegments,
  currentTaskPhase,
  groupToolCallsByPhase,
  messageBlocks
} from '../taskPhase'

function call(overrides: Partial<ToolCall>): ToolCall {
  return {
    id: overrides.id ?? Math.random().toString(36),
    name: 'test_tool',
    kind: 'read',
    title: 'Test',
    status: 'success',
    ...overrides
  }
}

describe('groupToolCallsByPhase', () => {
  it('groups reads as inspecting and writes as editing', () => {
    const groups = groupToolCallsByPhase([
      call({ kind: 'read' }),
      call({ kind: 'read' }),
      call({ kind: 'write' })
    ])
    expect(groups.map((g) => g.phase)).toEqual(['inspecting', 'editing'])
    expect(groups[0].calls).toHaveLength(2)
    expect(groups[1].calls).toHaveLength(1)
  })

  it('treats a command after an edit as verifying', () => {
    const groups = groupToolCallsByPhase([
      call({ kind: 'read' }),
      call({ kind: 'write' }),
      call({ kind: 'command' })
    ])
    expect(groups.map((g) => g.phase)).toEqual(['inspecting', 'editing', 'verifying'])
  })

  it('treats a command before any edit as inspecting', () => {
    const groups = groupToolCallsByPhase([call({ kind: 'command' })])
    expect(groups.map((g) => g.phase)).toEqual(['inspecting'])
  })
})

describe('currentTaskPhase', () => {
  it('returns null when there are no tool calls and no content yet', () => {
    expect(currentTaskPhase([], false)).toBeNull()
  })

  it('reflects the currently running call', () => {
    const calls = [
      call({ kind: 'read', status: 'success' }),
      call({ kind: 'write', status: 'running' })
    ]
    expect(currentTaskPhase(calls, false)).toBe('editing')
  })

  it('reports responding once tool calls are done and text is streaming', () => {
    const calls = [call({ kind: 'read', status: 'success' })]
    expect(currentTaskPhase(calls, true)).toBe('responding')
  })
})

function textBlock(text: string): MessageBlock {
  return { type: 'text', text }
}

function toolBlock(overrides: Partial<ToolCall>): MessageBlock {
  return { type: 'tool', call: call(overrides) }
}

describe('buildRenderSegments', () => {
  it('keeps text exactly where it occurred instead of clustering tools first', () => {
    const segments = buildRenderSegments([
      textBlock("I'll check the file first."),
      toolBlock({ kind: 'read' }),
      textBlock('Now updating it.'),
      toolBlock({ kind: 'write' })
    ])
    expect(segments.map((s) => s.type)).toEqual(['text', 'toolGroup', 'text', 'toolGroup'])
    expect((segments[0] as { text: string }).text).toBe("I'll check the file first.")
    expect((segments[2] as { text: string }).text).toBe('Now updating it.')
  })

  it('groups consecutive same-phase tool calls into one run', () => {
    const segments = buildRenderSegments([
      toolBlock({ kind: 'read' }),
      toolBlock({ kind: 'read' }),
      textBlock('Both look fine.')
    ])
    expect(segments).toHaveLength(2)
    expect(segments[0]).toMatchObject({ type: 'toolGroup', phase: 'inspecting' })
    expect((segments[0] as { calls: unknown[] }).calls).toHaveLength(2)
  })

  it('carries edit-seen state across a text-interrupted run, so a later command still verifies', () => {
    const segments = buildRenderSegments([
      toolBlock({ kind: 'write' }),
      textBlock("Let's verify that."),
      toolBlock({ kind: 'command' })
    ])
    expect(segments.map((s) => s.type)).toEqual(['toolGroup', 'text', 'toolGroup'])
    expect((segments[0] as { phase: string }).phase).toBe('editing')
    expect((segments[2] as { phase: string }).phase).toBe('verifying')
  })

  it('skips empty text blocks', () => {
    const segments = buildRenderSegments([textBlock(''), toolBlock({ kind: 'read' })])
    expect(segments).toEqual([
      { type: 'toolGroup', phase: 'inspecting', calls: [expect.anything()] }
    ])
  })

  it('does not let a whitespace-only token between calls split a same-phase run', () => {
    // Observed live: a model emitted a lone newline between two native
    // function calls, which used to count as a real text segment and split
    // one "Inspecting" run into two separate labeled groups.
    const segments = buildRenderSegments([
      toolBlock({ kind: 'read' }),
      textBlock('\n'),
      toolBlock({ kind: 'read' })
    ])
    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({ type: 'toolGroup', phase: 'inspecting' })
    expect((segments[0] as { calls: unknown[] }).calls).toHaveLength(2)
  })
})

describe('messageBlocks', () => {
  function message(overrides: Partial<ChatMessage>): ChatMessage {
    return {
      id: 'm1',
      role: 'assistant',
      content: '',
      createdAt: 0,
      ...overrides
    }
  }

  it('returns the live blocks when present', () => {
    const blocks: MessageBlock[] = [textBlock('hi')]
    expect(messageBlocks(message({ blocks, content: 'hi' }))).toEqual(blocks)
  })

  it('strips raw tool-call payloads from persisted text blocks', () => {
    const toolCalls = [call({ name: 'patch_file', kind: 'write' })]
    const blocks: MessageBlock[] = [
      textBlock(
        'I will patch this now. {"name": "patch_file", "arguments": {"path": "app.css", "replacements": []}}'
      )
    ]
    expect(messageBlocks(message({ blocks, toolCalls }))).toEqual([
      { type: 'text', text: 'I will patch this now.' }
    ])
  })

  it('keeps raw tool-like text when no real tool call exists', () => {
    const blocks: MessageBlock[] = [
      textBlock('Example: {"name": "read_file", "arguments": {"path": "app.ts"}}')
    ]
    expect(messageBlocks(message({ blocks }))).toEqual(blocks)
  })

  it('falls back to tools-then-text for messages persisted before blocks existed', () => {
    const toolCalls = [call({ kind: 'read' })]
    const result = messageBlocks(message({ toolCalls, content: 'Done.' }))
    expect(result).toEqual([
      { type: 'tool', call: toolCalls[0] },
      { type: 'text', text: 'Done.' }
    ])
  })

  it('returns an empty array for a message with no content and no tool calls', () => {
    expect(messageBlocks(message({}))).toEqual([])
  })
})
