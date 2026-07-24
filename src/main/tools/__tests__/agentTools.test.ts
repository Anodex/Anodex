import { describe, expect, it } from 'vitest'
import { finishGoalTool } from '../agentTools'
import type { ToolRuntimeContext } from '../types'
import { createMockContext, createMockDefine, captureCalls } from './test-helpers'

type FinishGoalHandler = (args: { summary: string }) => Promise<string>

function context(): ToolRuntimeContext {
  return createMockContext('/tmp/workspace')
}

describe('finish_goal', () => {
  it('reports the summary back to the model when a real action succeeded this turn', async () => {
    const ctx = context()
    ctx.progress.madeChange = true
    const tool = finishGoalTool(createMockDefine(), ctx) as unknown as {
      handler: FinishGoalHandler
    }

    const result = await tool.handler({ summary: 'Found the answer and reported it.' })

    expect(result).toContain('Run finished.')
  })

  it('rejects an empty summary', async () => {
    const ctx = context()
    ctx.progress.madeChange = true
    const tool = finishGoalTool(createMockDefine(), ctx) as unknown as {
      handler: FinishGoalHandler
    }

    const result = await tool.handler({ summary: '   ' })

    expect(result).toContain('Error')
    expect(result).toContain('summary was empty')
  })

  it('truncates a very long summary', async () => {
    const { calls, emit } = captureCalls()
    const ctx = { ...context(), emit }
    ctx.progress.madeChange = true
    const tool = finishGoalTool(createMockDefine(), ctx) as unknown as {
      handler: FinishGoalHandler
    }

    await tool.handler({ summary: 'a'.repeat(2000) })

    const finalCall = calls[calls.length - 1]
    expect(finalCall.status).toBe('success')
    expect(finalCall.detail!.length).toBeLessThan(1001)
  })

  it('refuses to report success when no other tool call has succeeded this turn', async () => {
    const { calls, emit } = captureCalls()
    const ctx = { ...context(), emit }
    // ctx.progress.madeChange defaults to false — nothing has happened yet.
    const tool = finishGoalTool(createMockDefine(), ctx) as unknown as {
      handler: FinishGoalHandler
    }

    const result = await tool.handler({ summary: 'Created hello2.txt containing "hello".' })

    expect(result).toContain('Error')
    expect(result).toContain('cannot be accepted')
    const finalCall = calls[calls.length - 1]
    expect(finalCall.status).toBe('error')
  })

  it('accepts success once a non-read tool call has succeeded this turn, even after an earlier refusal', async () => {
    const { calls, emit } = captureCalls()
    const ctx = { ...context(), emit }
    const tool = finishGoalTool(createMockDefine(), ctx) as unknown as {
      handler: FinishGoalHandler
    }

    const firstAttempt = await tool.handler({ summary: 'Created hello2.txt.' })
    expect(firstAttempt).toContain('Error')

    // Simulate write_file (or any other non-read tool) succeeding afterward.
    ctx.progress.madeChange = true

    const secondAttempt = await tool.handler({ summary: 'Created hello2.txt.' })
    expect(secondAttempt).toContain('Run finished.')
    expect(calls[calls.length - 1].status).toBe('success')
  })

  it('does not treat a read-only tool call as satisfying the progress check', async () => {
    const ctx = context()
    // A read tool succeeding must not, by itself, count as progress.
    ctx.progress.madeChange = false
    const tool = finishGoalTool(createMockDefine(), ctx) as unknown as {
      handler: FinishGoalHandler
    }

    const result = await tool.handler({ summary: 'Read the file and confirmed its contents.' })

    expect(result).toContain('Error')
  })
})
