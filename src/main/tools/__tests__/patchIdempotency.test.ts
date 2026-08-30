import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { patchFileTool } from '../mutationTools'
import { createMockContext, createMockDefine } from './test-helpers'

const ORIGINAL = ['import math', '', 'def step():', '    pass', ''].join('\n')

async function project() {
  const root = await mkdtemp(join(tmpdir(), 'anodex-patch-idem-'))
  await writeFile(join(root, 'physics.py'), ORIGINAL, 'utf-8')
  const ctx = createMockContext(root)
  const tool = patchFileTool(createMockDefine(), ctx) as unknown as {
    handler: (args: unknown) => Promise<string>
  }
  return { root, tool }
}

describe('patch_file applied twice', () => {
  // A patch whose newText contains its oldText is the ordinary way to insert a
  // line, and it is not idempotent: the second application finds oldText again
  // inside the text the first one wrote. A live run issued the same five
  // replacements twice and ended with the block duplicated three times over.
  it('does not duplicate an insertion when the same patch is repeated', async () => {
    const { root, tool } = await project()
    try {
      const insertion = {
        path: 'physics.py',
        replacements: [
          { oldText: 'def step():', newText: 'def total_mass():\n    pass\n\ndef step():' }
        ]
      }

      await tool.handler(insertion)
      const afterFirst = await readFile(join(root, 'physics.py'), 'utf-8')
      expect(afterFirst.match(/def total_mass\(\)/g)).toHaveLength(1)

      // The same call again. It must not add a second copy.
      await tool.handler(insertion).catch(() => undefined)

      const afterSecond = await readFile(join(root, 'physics.py'), 'utf-8')
      expect(afterSecond.match(/def total_mass\(\)/g)).toHaveLength(1)
      expect(afterSecond).toBe(afterFirst)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('says the patch was already applied rather than failing silently', async () => {
    const { root, tool } = await project()
    try {
      const insertion = {
        path: 'physics.py',
        replacements: [
          { oldText: 'def step():', newText: 'def total_mass():\n    pass\n\ndef step():' }
        ]
      }
      await tool.handler(insertion)

      const result = await tool.handler(insertion).catch((error: Error) => error.message)

      expect(String(result).toLowerCase()).toContain('already')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // A plain replacement is naturally idempotent-safe to repeat only because
  // oldText is gone afterwards; that behaviour must not change.
  it('still refuses a plain replacement whose oldText is gone', async () => {
    const { root, tool } = await project()
    try {
      const swap = {
        path: 'physics.py',
        replacements: [{ oldText: 'import math', newText: 'import numpy' }]
      }
      await tool.handler(swap)

      const result = await tool.handler(swap).catch((error: Error) => error.message)

      expect(String(result)).toMatch(/not found/i)
      expect(await readFile(join(root, 'physics.py'), 'utf-8')).toContain('import numpy')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
