import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { describeProjectToolchain } from '../projectToolchain'

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'anodex-toolchain-sync-'))
}

describe('describeProjectToolchain', () => {
  // The orientation summary a task starts from was built only from
  // package.json, so a Node project was told its own script names and every
  // other project was told nothing about how it is built or tested.
  it.each([
    ['pyproject.toml', 'Python', 'pytest'],
    ['Cargo.toml', 'Rust', 'cargo test'],
    ['go.mod', 'Go', 'go test'],
    ['pom.xml', 'Maven', 'mvn']
  ])('describes a project detected from %s', async (marker, label, command) => {
    const root = await workspace()
    try {
      await writeFile(join(root, marker), '', 'utf-8')

      const described = describeProjectToolchain(root)

      expect(described).toContain(label)
      expect(described).toContain(marker)
      expect(described).toContain(command)
      // These are conventions, not commands verified to exist in this project,
      // and the line has to say so rather than implying it checked.
      expect(described?.toLowerCase()).toContain('conventional')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // Node already contributes its real script names from package.json, which is
  // a better signal than convention, so this must not talk over it.
  it('says nothing for a Node project', async () => {
    const root = await workspace()
    try {
      await writeFile(join(root, 'package.json'), '{"name":"x"}', 'utf-8')

      expect(describeProjectToolchain(root)).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('says nothing when it recognises nothing', async () => {
    const root = await workspace()
    try {
      await writeFile(join(root, 'notes.txt'), 'hello', 'utf-8')

      expect(describeProjectToolchain(root)).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
