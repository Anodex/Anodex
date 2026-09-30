import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/chat.types'
import type { ToolCall } from '@shared/tools.types'
import { activityOf, isWorking, outputsOf, planProgress, readablePath } from '../dockActivity'

function call(id: string, over: Partial<ToolCall> = {}): ToolCall {
  return { id, name: 'edit_file', kind: 'write', title: `Edit ${id}`, status: 'success', ...over }
}

function message(createdAt: number, toolCalls: ToolCall[]): ChatMessage {
  return { id: `m${createdAt}`, role: 'assistant', content: '', createdAt, toolCalls }
}

describe('dock activity', () => {
  it('lists every tool call newest first, stamped with its turn', () => {
    const activity = activityOf([message(1, [call('a'), call('b')]), message(2, [call('c')])])
    expect(activity.map((item) => item.call.id)).toEqual(['c', 'b', 'a'])
    expect(activity[0].at).toBe(2)
  })

  it('is working only while a call is running', () => {
    expect(isWorking([message(1, [call('a')])])).toBe(false)
    expect(isWorking([message(1, [call('a', { status: 'running' })])])).toBe(true)
    expect(isWorking(undefined)).toBe(false)
  })

  it('collects each touched file once, most recent first, from successful calls only', () => {
    const outputs = outputsOf(
      activityOf([
        message(1, [call('a', { touchedPaths: ['src/a.ts', 'src/b.ts'] })]),
        message(2, [call('b', { touchedPaths: ['src/a.ts'] })]),
        message(3, [call('c', { status: 'error', touchedPaths: ['src/c.ts'] })])
      ])
    )
    expect(outputs.map((o) => o.path)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(outputs[0]).toMatchObject({ title: 'Edit b', at: 2 })
  })

  it('reports plan progress, and nothing for an empty plan', () => {
    expect(planProgress(undefined)).toBeNull()
    expect(planProgress({ title: 'x', steps: [], updatedAt: 0 })).toBeNull()
    expect(
      planProgress({
        title: 'x',
        updatedAt: 0,
        steps: [
          { id: '1', title: 'a', status: 'completed' },
          { id: '2', title: 'b', status: 'in_progress' }
        ]
      })
    ).toEqual({ done: 1, total: 2 })
  })

  it('names the project folder instead of showing a lone full stop', () => {
    expect(readablePath('.')).toBe('project root')
    expect(readablePath('./')).toBe('project root')
    expect(readablePath('src/app.ts')).toBe('src/app.ts')
  })
})
