import { describe, expect, it } from 'vitest'
import type { ChatMessage, MessageBlock } from '@shared/chat.types'
import type { ToolCall } from '@shared/tools.types'
import {
  buildRenderSegments,
  currentTaskPhase,
  foldSettledTimeline,
  groupSegmentsForTimeline,
  groupToolCallsByPhase,
  liveActivityLabel,
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

describe('liveActivityLabel', () => {
  it('describes the running tool as work in progress, not a finished record', () => {
    expect(
      liveActivityLabel(
        [call({ title: 'Read src/renderer/features/chat/MessageBubble.tsx', status: 'running' })],
        false
      )
    ).toBe('Reading MessageBubble.tsx')
  })

  it('shows a title it cannot rephrase unchanged rather than inventing grammar', () => {
    expect(liveActivityLabel([call({ title: 'Git status', status: 'running' })], false)).toBe(
      'Git status'
    )
  })

  /**
   * The gap between two calls is the model deciding what to do next. The step
   * that just finished is the only thing about that moment actually known, so
   * it is what the indicator names -- rather than the contentless "Preparing
   * next step" this used to sit on.
   */
  it('names the step just finished while the model decides on the next one', () => {
    expect(liveActivityLabel([call({ title: 'Run: pytest', status: 'success' })], false)).toBe(
      'Thinking after running pytest'
    )
    expect(
      liveActivityLabel(
        [
          call({ title: 'Read a.py', status: 'success' }),
          call({ title: 'Edit b.py', status: 'error' })
        ],
        false
      )
    ).toBe('Thinking after editing b.py')
  })

  it('falls back to plain wording when nothing has happened it can name', () => {
    expect(liveActivityLabel([], false)).toBe('Thinking')
    expect(liveActivityLabel([call({ title: 'Git status', status: 'success' })], false)).toBe(
      'Thinking'
    )
    expect(liveActivityLabel([], true)).toBe('Writing response')
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

describe('groupSegmentsForTimeline', () => {
  it('folds a leading run of thinking/tool segments into one work block, leaving the final text separate', () => {
    const segments = buildRenderSegments([
      { type: 'thinking', text: 'Let me look.' },
      toolBlock({ kind: 'read' }),
      { type: 'thinking', text: 'Now fixing it.' },
      toolBlock({ kind: 'write' }),
      textBlock('Done!')
    ])
    const blocks = groupSegmentsForTimeline(segments)
    expect(blocks.map((b) => b.type)).toEqual(['work', 'text'])
    expect((blocks[0] as { segments: unknown[] }).segments).toHaveLength(4)
    expect((blocks[1] as { text: string }).text).toBe('Done!')
  })

  it('keeps interleaved text segments in place instead of merging across them', () => {
    const segments = buildRenderSegments([
      toolBlock({ kind: 'write' }),
      textBlock('Checking that.'),
      toolBlock({ kind: 'command' })
    ])
    const blocks = groupSegmentsForTimeline(segments)
    expect(blocks.map((b) => b.type)).toEqual(['work', 'text', 'work'])
  })

  it('rejoins a visible sentence split by reasoning activity', () => {
    const blocks = groupSegmentsForTimeline([
      { type: 'text', text: 'Let' },
      { type: 'thinking', text: ' the plan.' },
      { type: 'text', text: 'me check the current state.' }
    ])

    expect(blocks.map((block) => block.type)).toEqual(['work', 'text'])
    expect((blocks[1] as { type: 'text'; text: string }).text).toBe(
      'Let me check the current state.'
    )
  })

  it('rejoins a visible sentence split by a tool call', () => {
    const blocks = groupSegmentsForTimeline([
      { type: 'text', text: 'Let me check the current state of' },
      { type: 'toolGroup', phase: 'inspecting', calls: [call({ kind: 'read' })] },
      { type: 'text', text: 'the project files.' }
    ])

    expect(blocks.map((block) => block.type)).toEqual(['work', 'text'])
    expect((blocks[1] as { type: 'text'; text: string }).text).toBe(
      'Let me check the current state of the project files.'
    )
  })

  it('moves a short abandoned fragment into work details instead of showing broken prose', () => {
    const blocks = groupSegmentsForTimeline([
      { type: 'text', text: 'That' },
      { type: 'thinking', text: ' we left off.' },
      { type: 'text', text: "Instagram email isn't related to the project." }
    ])

    expect(blocks.map((block) => block.type)).toEqual(['work', 'text'])
    expect((blocks[0] as { type: 'work'; segments: unknown[] }).segments).toHaveLength(2)
    expect((blocks[1] as { type: 'text'; text: string }).text).toBe(
      "Instagram email isn't related to the project."
    )
  })

  it('hides an unfinished live fragment until its continuation arrives', () => {
    const blocks = groupSegmentsForTimeline([
      { type: 'text', text: 'Let' },
      { type: 'thinking', text: ' me inspect the plan.' }
    ])

    expect(blocks.map((block) => block.type)).toEqual(['work'])
    expect((blocks[0] as { type: 'work'; segments: unknown[] }).segments).toHaveLength(2)
  })

  it('returns an empty array for no segments', () => {
    expect(groupSegmentsForTimeline([])).toEqual([])
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

  it('strips raw tool payloads even when no tool call was recorded', () => {
    const blocks: MessageBlock[] = [
      textBlock('I will inspect that. {"name": "read_file", "arguments": {"path": "app.ts"}}')
    ]
    expect(messageBlocks(message({ blocks }))).toEqual([
      { type: 'text', text: 'I will inspect that.' }
    ])
  })

  it('keeps ordinary JSON text', () => {
    const blocks: MessageBlock[] = [textBlock('Example: {"value": 1, "label": "demo"}')]
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

/**
 * A forty-minute turn leaves dozens of tool cards and every "let me check the
 * shader link status" the model wrote on the way through. `TurnRecap` already
 * folded the tool calls away and left the prose -- the half that is actually
 * long. A finished reply should show its answer.
 */
describe('foldSettledTimeline', () => {
  const text = (t: string): MessageBlock => ({ type: 'text', text: t })
  const toolBlockOf = (title: string): MessageBlock => toolBlock({ title, status: 'success' })
  const timelineOf = (...blocks: MessageBlock[]) =>
    groupSegmentsForTimeline(buildRenderSegments(blocks))

  it('folds narration and tool calls into one run, keeping the closing answer', () => {
    const folded = foldSettledTimeline(
      timelineOf(text('Let me check the shader.'), toolBlockOf('Read gl.cpp'), text('Fixed it.'))
    )

    expect(folded).toHaveLength(2)
    expect(folded[0].type).toBe('work')
    expect(folded[1]).toEqual({ type: 'text', text: 'Fixed it.' })
    // The narration is inside the fold, not lost.
    const work = folded[0]
    if (work.type !== 'work') throw new Error('expected a work block')
    expect(work.segments.some((s) => s.type === 'text')).toBe(true)
  })

  /** Prose before more work was narration, not a conclusion. */
  it('keeps out only trailing text, not prose that came before more work', () => {
    const folded = foldSettledTimeline(
      timelineOf(
        text('First I will look.'),
        toolBlockOf('Read a.ts'),
        text('Now the edit.'),
        toolBlockOf('Edit a.ts')
      )
    )

    expect(folded).toHaveLength(1)
    expect(folded[0].type).toBe('work')
  })

  /** A turn cut short mid-tool collapses to the outcome alone. */
  it('folds a reply that never got to write a conclusion', () => {
    const folded = foldSettledTimeline(timelineOf(toolBlockOf('Read a.ts')))

    expect(folded).toHaveLength(1)
    expect(folded[0].type).toBe('work')
  })

  /** No stray toggle above a plain answer. */
  it('leaves a reply with no tool calls exactly as it was', () => {
    const plain = timelineOf(text('Just an answer.'))

    expect(foldSettledTimeline(plain)).toEqual(plain)
  })
})
