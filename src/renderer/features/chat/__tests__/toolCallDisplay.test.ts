import { describe, expect, it } from 'vitest'
import type { ToolCall } from '@shared/tools.types'
import { getToolCallDisplay } from '../toolCallDisplay'

function call(overrides: Partial<ToolCall>): ToolCall {
  return {
    id: 'call-1',
    name: 'read_file_range',
    kind: 'read',
    title: 'Read index.html lines 1100–1200',
    status: 'success',
    ...overrides
  }
}

describe('getToolCallDisplay', () => {
  it('splits the leading tool action from the target for easier scanning', () => {
    expect(getToolCallDisplay(call({ title: 'Read index.html lines 1100–1200' }))).toMatchObject({
      action: 'Read',
      target: 'index.html lines 1100–1200'
    })
  })

  it('normalizes colon-delimited command titles', () => {
    expect(getToolCallDisplay(call({ kind: 'command', title: 'Run: npm test -- --run app.test.ts' }))).toMatchObject({
      action: 'Run',
      target: 'npm test -- --run app.test.ts'
    })
  })

  it('uses detail as the right-side metadata when present', () => {
    expect(getToolCallDisplay(call({ detail: '2 matches' })).meta).toBe('2 matches')
  })

  it('uses diff stats as metadata for edit calls when no detail exists', () => {
    expect(
      getToolCallDisplay(
        call({
          kind: 'write',
          title: 'Edit index.html',
          detail: undefined,
          diff: { path: 'index.html', before: 'one\n', after: 'one\ntwo\n' }
        })
      ).meta
    ).toBe('+1 -0')
  })
})
