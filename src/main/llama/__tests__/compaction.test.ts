import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ChatHistoryTurn } from '@shared/chat.types'
import {
  buildCompactionSystemPrompt,
  MAX_RESERVED_NON_HISTORY_TOKENS,
  MIN_RESERVED_NON_HISTORY_TOKENS,
  NODE_LLAMA_CPP_CONTEXT_SHIFT_CRASH_FRAGMENT,
  renderTurnsForSummary,
  reservedNonHistoryTokens,
  splitHistoryByTokenBudget
} from '../compaction'

/** Deterministic fake tokenizer for tests: 1 token per character. */
const countTokens = (text: string): number => text.length

describe('reservedNonHistoryTokens', () => {
  it('scales as a fraction of contextSize in the normal range', () => {
    expect(reservedNonHistoryTokens(16000)).toBe(3200) // 20% of 16000
  })

  it('floors small contexts instead of reserving almost nothing', () => {
    expect(reservedNonHistoryTokens(1000)).toBe(MIN_RESERVED_NON_HISTORY_TOKENS)
  })

  it('caps huge contexts instead of reserving a proportionally huge chunk', () => {
    expect(reservedNonHistoryTokens(1_000_000)).toBe(MAX_RESERVED_NON_HISTORY_TOKENS)
  })
})

describe('splitHistoryByTokenBudget', () => {
  it('returns everything as recent when history is empty', () => {
    expect(splitHistoryByTokenBudget([], 100, countTokens)).toEqual({ recent: [], older: [] })
  })

  it('keeps everything verbatim when it all fits the budget', () => {
    const history: ChatHistoryTurn[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' }
    ]
    expect(splitHistoryByTokenBudget(history, 100, countTokens)).toEqual({
      recent: history,
      older: []
    })
  })

  it('splits off older turns that do not fit, keeping the newest verbatim', () => {
    const history: ChatHistoryTurn[] = [
      { role: 'user', content: 'a'.repeat(50) },
      { role: 'assistant', content: 'b'.repeat(50) },
      { role: 'user', content: 'c'.repeat(10) },
      { role: 'assistant', content: 'd'.repeat(10) }
    ]
    const result = splitHistoryByTokenBudget(history, 25, countTokens)
    expect(result.recent).toEqual([history[2], history[3]])
    expect(result.older).toEqual([history[0], history[1]])
  })

  it('always keeps at least the newest turn, even if it alone exceeds the budget', () => {
    const history: ChatHistoryTurn[] = [
      { role: 'user', content: 'short' },
      { role: 'assistant', content: 'x'.repeat(1000) }
    ]
    const result = splitHistoryByTokenBudget(history, 10, countTokens)
    expect(result.recent).toEqual([history[1]])
    expect(result.older).toEqual([history[0]])
  })

  it('counts tool-call results toward a turn\'s token cost', () => {
    const history: ChatHistoryTurn[] = [
      { role: 'user', content: 'do it' },
      {
        role: 'assistant',
        content: 'done',
        toolCalls: [
          {
            id: 't1',
            name: 'read_file',
            kind: 'read',
            title: 'Read x',
            status: 'success',
            result: 'y'.repeat(100)
          }
        ]
      }
    ]
    // Budget fits the assistant turn's own text but not its tool result too.
    const result = splitHistoryByTokenBudget(history, 20, countTokens)
    expect(result.recent).toEqual([history[1]])
    expect(result.older).toEqual([history[0]])
  })
})

describe('renderTurnsForSummary', () => {
  it('renders user and assistant turns as a plain transcript', () => {
    const history: ChatHistoryTurn[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' }
    ]
    expect(renderTurnsForSummary(history)).toBe('User: hi\nAssistant: hello')
  })

  it('annotates assistant turns with their tool calls', () => {
    const history: ChatHistoryTurn[] = [
      {
        role: 'assistant',
        content: 'Read the file.',
        toolCalls: [
          { id: 't1', name: 'read_file', kind: 'read', title: 'Read x', status: 'success', detail: '42 lines' }
        ]
      }
    ]
    expect(renderTurnsForSummary(history)).toBe('Assistant: Read the file. [called read_file → 42 lines]')
  })

  it('prefers the tool call result over its detail, truncated to a preview', () => {
    const history: ChatHistoryTurn[] = [
      {
        role: 'assistant',
        content: 'Read the file.',
        toolCalls: [
          {
            id: 't1',
            name: 'read_file',
            kind: 'read',
            title: 'Read x',
            status: 'success',
            detail: '42 lines',
            result: 'y'.repeat(400)
          }
        ]
      }
    ]
    expect(renderTurnsForSummary(history)).toBe(
      `Assistant: Read the file. [called read_file → ${'y'.repeat(300)}…]`
    )
  })
})

describe('NODE_LLAMA_CPP_CONTEXT_SHIFT_CRASH_FRAGMENT', () => {
  it('still matches the actual installed node-llama-cpp crash message', () => {
    // LlamaService.ts detects node-llama-cpp's context-shift crash by
    // substring match, since node-llama-cpp throws a plain `new Error(...)`
    // with no error class or code for this condition. That match is only as
    // good as this fragment staying in sync with the real dependency — this
    // test reads node-llama-cpp's actual installed source so an `npm
    // update`/version bump that rewords the message fails this test
    // immediately, instead of the reactive compaction safety net silently
    // going dark in production.
    const source = readFileSync(
      join(
        process.cwd(),
        'node_modules/node-llama-cpp/dist/evaluator/LlamaChat/LlamaChat.js'
      ),
      'utf-8'
    )
    expect(source).toContain(NODE_LLAMA_CPP_CONTEXT_SHIFT_CRASH_FRAGMENT)
  })
})

describe('buildCompactionSystemPrompt', () => {
  it('appends the summary block after the existing system prompt', () => {
    const result = buildCompactionSystemPrompt('Be helpful.', 'User asked about X.')
    expect(result).toBe(
      'Be helpful.\n\n---\nSummary of earlier conversation (compacted to fit the context window):\nUser asked about X.'
    )
  })

  it('produces just the summary block when there is no system prompt', () => {
    const result = buildCompactionSystemPrompt(undefined, 'User asked about X.')
    expect(result).toBe(
      'Summary of earlier conversation (compacted to fit the context window):\nUser asked about X.'
    )
  })
})
