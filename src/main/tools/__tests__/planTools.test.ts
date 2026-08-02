import { describe, expect, it } from 'vitest'
import { writePlanTool, updatePlanStepTool } from '../planTools'
import type { ToolRuntimeContext } from '../types'
import { createMockContext, createMockDefine } from './test-helpers'

type WritePlanHandler = (args: { title: string; steps: string[] }) => Promise<string>
type UpdateStepHandler = (args: {
  stepNumber: number
  status: 'in_progress' | 'completed'
}) => Promise<string>

function context(): ToolRuntimeContext {
  return createMockContext('/tmp/workspace')
}

describe('AI plan tools', () => {
  describe('write_plan', () => {
    it('creates a plan and stores it on the shared context', async () => {
      const ctx = context()
      const tool = writePlanTool(createMockDefine(), ctx) as unknown as {
        handler: WritePlanHandler
      }

      const result = await tool.handler({
        title: 'Fix the bug',
        steps: ['Read the file', 'Edit it']
      })

      expect(result).toContain('2 step(s)')
      expect(ctx.plan.current).not.toBeNull()
      expect(ctx.plan.current?.title).toBe('Fix the bug')
      expect(ctx.plan.current?.steps).toHaveLength(2)
      expect(ctx.plan.current?.steps.every((step) => step.status === 'pending')).toBe(true)
      expect(ctx.plan.current?.steps[0].title).toBe('Read the file')
    })

    it('echoes the numbered steps and the update_plan_step contract back to the model', async () => {
      const ctx = context()
      const tool = writePlanTool(createMockDefine(), ctx) as unknown as {
        handler: WritePlanHandler
      }

      const result = await tool.handler({
        title: 'Fix the bug',
        steps: ['Read the file', 'Edit it']
      })

      expect(result).toContain('1. Read the file')
      expect(result).toContain('2. Edit it')
      expect(result).toContain('update_plan_step')
      // Models were reaching for `update_change_task` with a slug derived from
      // the plan title; the result states outright that no slug exists.
      expect(result).toContain('no slug')
    })

    it('caps the number of steps', async () => {
      const ctx = context()
      const tool = writePlanTool(createMockDefine(), ctx) as unknown as {
        handler: WritePlanHandler
      }

      const steps = Array.from({ length: 50 }, (_, i) => `Step ${i}`)
      await tool.handler({ title: 'Big plan', steps })

      expect(ctx.plan.current?.steps.length).toBeLessThanOrEqual(30)
    })

    it('replaces an existing plan on a second call', async () => {
      const ctx = context()
      const tool = writePlanTool(createMockDefine(), ctx) as unknown as {
        handler: WritePlanHandler
      }

      await tool.handler({ title: 'First', steps: ['A', 'B'] })
      await tool.handler({ title: 'Second', steps: ['C'] })

      expect(ctx.plan.current?.title).toBe('Second')
      expect(ctx.plan.current?.steps).toHaveLength(1)
    })

    it('rejects an empty step list instead of creating a zero-step plan', async () => {
      const ctx = context()
      const tool = writePlanTool(createMockDefine(), ctx) as unknown as {
        handler: WritePlanHandler
      }

      const result = await tool.handler({ title: 'Empty plan', steps: [] })

      expect(result).toContain('at least one step')
      expect(ctx.plan.current).toBeNull()
    })

    it('rejects a step list that is only whitespace', async () => {
      const ctx = context()
      const tool = writePlanTool(createMockDefine(), ctx) as unknown as {
        handler: WritePlanHandler
      }

      const result = await tool.handler({ title: 'Whitespace plan', steps: ['  ', '\t'] })

      expect(result).toContain('at least one step')
      expect(ctx.plan.current).toBeNull()
    })

    it('rejects a blank title', async () => {
      const ctx = context()
      const tool = writePlanTool(createMockDefine(), ctx) as unknown as {
        handler: WritePlanHandler
      }

      const result = await tool.handler({ title: '   ', steps: ['A step'] })

      expect(result).toContain('non-empty title')
      expect(ctx.plan.current).toBeNull()
    })

    it('does not replace a previously-valid plan with a rejected empty one', async () => {
      const ctx = context()
      const tool = writePlanTool(createMockDefine(), ctx) as unknown as {
        handler: WritePlanHandler
      }

      await tool.handler({ title: 'Valid plan', steps: ['A step'] })
      await tool.handler({ title: 'Replacement attempt', steps: [] })

      expect(ctx.plan.current?.title).toBe('Valid plan')
    })
  })

  describe('update_plan_step', () => {
    it('marks a step by its 1-based position', async () => {
      const ctx = context()
      const write = writePlanTool(createMockDefine(), ctx) as unknown as {
        handler: WritePlanHandler
      }
      const update = updatePlanStepTool(createMockDefine(), ctx) as unknown as {
        handler: UpdateStepHandler
      }

      await write.handler({ title: 'Plan', steps: ['First', 'Second'] })
      const result = await update.handler({ stepNumber: 2, status: 'completed' })

      expect(result).toContain('completed')
      expect(ctx.plan.current?.steps[0].status).toBe('pending')
      expect(ctx.plan.current?.steps[1].status).toBe('completed')
    })

    it('reports an error to the model when no plan exists yet', async () => {
      const ctx = context()
      const update = updatePlanStepTool(createMockDefine(), ctx) as unknown as {
        handler: UpdateStepHandler
      }

      const result = await update.handler({ stepNumber: 1, status: 'in_progress' })

      expect(result).toContain('No plan exists yet')
    })

    it('reports an error to the model for an out-of-range step number', async () => {
      const ctx = context()
      const write = writePlanTool(createMockDefine(), ctx) as unknown as {
        handler: WritePlanHandler
      }
      const update = updatePlanStepTool(createMockDefine(), ctx) as unknown as {
        handler: UpdateStepHandler
      }

      await write.handler({ title: 'Plan', steps: ['Only step'] })
      const result = await update.handler({ stepNumber: 5, status: 'completed' })

      expect(result).toContain('No step 5')
      // The real positions come back with the error so the model can retry
      // correctly instead of just learning that 5 was wrong.
      expect(result).toContain('1. Only step')
    })

    it('reports remaining progress so the model knows what is still open', async () => {
      const ctx = context()
      const write = writePlanTool(createMockDefine(), ctx) as unknown as {
        handler: WritePlanHandler
      }
      const update = updatePlanStepTool(createMockDefine(), ctx) as unknown as {
        handler: UpdateStepHandler
      }

      await write.handler({ title: 'Plan', steps: ['First', 'Second', 'Third'] })
      const result = await update.handler({ stepNumber: 1, status: 'completed' })

      expect(result).toContain('1/3 steps complete')
      expect(result).toContain('Next unstarted step is 2 ("Second")')
    })

    it('says so once every step is complete', async () => {
      const ctx = context()
      const write = writePlanTool(createMockDefine(), ctx) as unknown as {
        handler: WritePlanHandler
      }
      const update = updatePlanStepTool(createMockDefine(), ctx) as unknown as {
        handler: UpdateStepHandler
      }

      await write.handler({ title: 'Plan', steps: ['Only step'] })
      const result = await update.handler({ stepNumber: 1, status: 'completed' })

      expect(result).toContain('All steps are now complete')
    })
  })
})
