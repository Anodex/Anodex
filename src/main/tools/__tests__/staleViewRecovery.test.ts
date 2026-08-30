import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { replaceLinesTool } from '../mutationTools'
import { createMockContext, createMockDefine } from './test-helpers'

/**
 * End-to-end, through the real tool. The ledger unit tests for this passed
 * while the signal never reached it once before — `helpers.ts` handles a thrown
 * tool error in its own catch block, and a value added anywhere else is simply
 * not seen there.
 */
describe('a real failed edit unblocks the read that repairs it', () => {
  it('grants a read after replace_lines rejects a stale line number', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anodex-stale-'))
    try {
      await writeFile(join(root, 'a.py'), 'def one():\n    pass\n\ndef two():\n    pass\n', 'utf-8')
      const ctx = createMockContext(root)
      // Put the guard into its blocking state.
      for (let i = 0; i < 40; i++) ctx.ledger.recordOutcome({ kind: 'read', madeProgress: true })
      expect(ctx.ledger.reviewCall({ name: 'read_file', kind: 'read', key: 'a' }).action).toBe(
        'block'
      )

      const tool = replaceLinesTool(createMockDefine(), ctx) as unknown as {
        handler: (args: unknown) => Promise<string>
      }
      // An anchor that does not match the line it names: the model's picture of
      // the file is wrong, which is exactly what earns a read back.
      const result = await tool.handler({
        path: 'a.py',
        startLine: 1,
        endLine: 1,
        newText: 'def uno():',
        expectedFirstLine: 'def something_else():'
      })

      expect(result).toContain('Error')
      expect(ctx.ledger.reviewCall({ name: 'read_file', kind: 'read', key: 'b' }).action).toBe(
        'run'
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
