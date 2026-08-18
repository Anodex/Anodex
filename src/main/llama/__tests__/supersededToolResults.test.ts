import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { describe, expect, it } from 'vitest'
import { collapseSupersededToolResults } from '../supersededToolResults'

function assistant(id: string, name: string, args: unknown): ChatCompletionMessageParam {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
  }
}

const toolResult = (id: string, content: string): ChatCompletionMessageParam => ({
  role: 'tool',
  tool_call_id: id,
  content
})

const read = (id: string, path: string, extra: object = {}) => [
  assistant(id, 'read_file_range', { path, ...extra }),
  toolResult(id, `contents of ${path}`)
]

const write = (id: string, path: string) => [
  assistant(id, 'replace_lines', { path }),
  toolResult(id, 'edit applied')
]

const contentOf = (messages: ChatCompletionMessageParam[], id: string): string => {
  const found = messages.find((m) => m.role === 'tool' && m.tool_call_id === id)
  return typeof found?.content === 'string' ? found.content : ''
}

describe('collapseSupersededToolResults', () => {
  // The gap this closes: a live run made 167 calls inside one turn, so every
  // read and write lived in this array and never met the history projection.
  it('replaces an earlier read of a file that was later written', () => {
    const messages = [...read('r1', 'a.ts'), ...write('w1', 'a.ts')]

    expect(collapseSupersededToolResults(messages)).toBe(1)
    expect(contentOf(messages, 'r1')).toContain('no longer match what is on disk')
  })

  it('leaves a read that happened after the write', () => {
    const messages = [...write('w1', 'a.ts'), ...read('r1', 'a.ts')]

    expect(collapseSupersededToolResults(messages)).toBe(0)
    expect(contentOf(messages, 'r1')).toBe('contents of a.ts')
  })

  it('keeps only the newest of two identical reads', () => {
    const messages = [...read('r1', 'a.ts'), ...read('r2', 'a.ts')]

    expect(collapseSupersededToolResults(messages)).toBe(1)
    expect(contentOf(messages, 'r1')).toContain('repeated later in this turn')
    expect(contentOf(messages, 'r2')).toBe('contents of a.ts')
  })

  // Two ranges of one file are different content, not a repeat.
  it('keeps two different ranges of the same file', () => {
    const messages = [
      ...read('r1', 'a.ts', { startLine: 1 }),
      ...read('r2', 'a.ts', { startLine: 200 })
    ]

    expect(collapseSupersededToolResults(messages)).toBe(0)
  })

  it('does not touch a write of one file when another was edited', () => {
    const messages = [...read('r1', 'a.ts'), ...write('w1', 'b.ts')]

    expect(collapseSupersededToolResults(messages)).toBe(0)
  })

  // Called once per round, so it must be idempotent or the notice stacks.
  it('is stable when run repeatedly', () => {
    const messages = [...read('r1', 'a.ts'), ...write('w1', 'a.ts')]

    expect(collapseSupersededToolResults(messages)).toBe(1)
    expect(collapseSupersededToolResults(messages)).toBe(0)
    expect(contentOf(messages, 'r1')).toContain('no longer match what is on disk')
  })

  it('ignores a tool result whose call it cannot identify', () => {
    const messages: ChatCompletionMessageParam[] = [toolResult('orphan', 'something')]

    expect(collapseSupersededToolResults(messages)).toBe(0)
  })

  it('survives arguments that are not valid JSON', () => {
    const messages: ChatCompletionMessageParam[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'r1', type: 'function', function: { name: 'read_file', arguments: '{broken' } }
        ]
      },
      toolResult('r1', 'body')
    ]

    expect(() => collapseSupersededToolResults(messages)).not.toThrow()
  })
})
