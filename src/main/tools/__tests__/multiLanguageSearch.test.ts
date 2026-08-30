import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { searchFilesTool, listDirectoryTool } from '../fileTools'
import { createMockContext, createMockDefine } from './test-helpers'

/**
 * End-to-end cover for the multi-language fixes. Each was unit-tested against
 * its own list; these drive the real tools over a real project layout, which is
 * the level the bug actually lived at — a language missing from `TEXT_EXT` did
 * not search badly, it searched to nothing, and nothing said a filter applied.
 */
async function rustProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'anodex-multilang-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, 'target', 'debug'), { recursive: true })
  await writeFile(join(root, 'Cargo.toml'), '[package]\nname = "roman"\n', 'utf-8')
  await writeFile(join(root, 'src', 'lib.rs'), 'pub fn to_roman() {}\n', 'utf-8')
  await writeFile(join(root, 'Makefile'), 'check:\n\tcargo test\n', 'utf-8')
  // Build output: real Cargo puts copies of the source here, which is exactly
  // why searching it drowns the real answer.
  await writeFile(join(root, 'target', 'debug', 'lib.rs'), 'pub fn to_roman() {}\n', 'utf-8')
  return root
}

function tools(root: string) {
  const ctx = createMockContext(root)
  return {
    search: searchFilesTool(createMockDefine(), ctx) as unknown as {
      handler: (args: unknown) => Promise<string>
    },
    list: listDirectoryTool(createMockDefine(), ctx) as unknown as {
      handler: (args: unknown) => Promise<string>
    }
  }
}

describe('searching a project that is not JavaScript', () => {
  it('finds a symbol in a .rs file', async () => {
    const root = await rustProject()
    try {
      const result = await tools(root).search.handler({ query: 'to_roman' })

      expect(result).toContain('lib.rs')
      expect(result).not.toContain('No matches found')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not search build output', async () => {
    const root = await rustProject()
    try {
      const result = await tools(root).search.handler({ query: 'to_roman' })

      expect(result).not.toContain('target')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('finds a Makefile, which has no extension at all', async () => {
    const root = await rustProject()
    try {
      const result = await tools(root).search.handler({ query: 'cargo test' })

      expect(result).toContain('Makefile')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // Deliberately NOT symmetric with search. A listing is a statement about what
  // is on disk, so hiding a real directory would make it lie; the model can
  // decide not to descend. Skipping build output when *searching* is different -
  // there the copies drown the real answer. Do not "fix" this into agreement.
  it('still lists build output, because it is really there', async () => {
    const root = await rustProject()
    try {
      const result = await tools(root).list.handler({ path: '.' })

      expect(result).toContain('src')
      expect(result).toContain('target')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
