import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { runCommandTool } from '../commandTools'
import { createMockContext, createMockDefine } from './test-helpers'

/**
 * End-to-end cover for the gathering streak, driven through the real tool.
 *
 * The unit test for this lived on `TaskLedger` and passed while the value never
 * reached it: `helpers.ts` destructures a tool's result explicitly, so a new
 * field was silently dropped and production behaviour did not change at all.
 * That is the same shape as the hardcoded blanks found earlier in agent turns,
 * and the reason this test drives the tool rather than the ledger.
 */
async function context() {
  const root = await mkdtemp(join(tmpdir(), 'anodex-streak-'))
  return { root, ctx: createMockContext(root) }
}

function streakOf(ctx: ReturnType<typeof createMockContext>): number {
  const verdict = ctx.ledger.reviewCall({
    name: 'read_file',
    kind: 'read',
    key: Math.random().toString()
  })
  return Number(
    /You have made (\d+) information-gathering calls/.exec(verdict.message ?? '')?.[1] ?? 0
  )
}

describe('run_command and the gathering streak', () => {
  it('an unrecognised command does not reset a streak the reads built up', async () => {
    const { root, ctx } = await context()
    try {
      for (let i = 0; i < 25; i++) ctx.ledger.recordOutcome({ kind: 'read', madeProgress: true })
      const before = streakOf(ctx)
      expect(before).toBeGreaterThan(0)

      const tool = runCommandTool(createMockDefine(), ctx) as unknown as {
        handler: (args: unknown) => Promise<string>
      }
      // Neither a recognised read nor a recognised write - exactly the shape
      // that bought 82 free resets in the measured run.
      await tool.handler({ command: 'python -c "print(1)"' })

      expect(streakOf(ctx)).toBe(before)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
