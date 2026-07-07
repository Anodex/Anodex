import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveInWorkspace, toWorkspaceRelative } from '../workspace'

describe('workspace path safety', () => {
  const root = 'C:\\Users\\Owner\\workspace'

  describe('resolveInWorkspace', () => {
    it('resolves a relative path inside the workspace', () => {
      expect(resolveInWorkspace(root, 'src/index.ts')).toBe(
        'C:\\Users\\Owner\\workspace\\src\\index.ts'
      )
    })

    it('resolves an absolute path inside the workspace', () => {
      expect(resolveInWorkspace(root, 'C:\\Users\\Owner\\workspace\\src\\index.ts')).toBe(
        'C:\\Users\\Owner\\workspace\\src\\index.ts'
      )
    })

    it('resolves the workspace root for "."', () => {
      expect(resolveInWorkspace(root, '.')).toBe('C:\\Users\\Owner\\workspace')
    })

    it('blocks paths that escape the workspace via ..', () => {
      expect(() => resolveInWorkspace(root, '../secrets.txt')).toThrow(/outside the workspace/)
    })

    it('blocks absolute paths outside the workspace', () => {
      expect(() => resolveInWorkspace(root, 'C:\\Windows\\system32\\notepad.exe')).toThrow(
        /outside the workspace/
      )
    })

    it('blocks paths that escape through a symlink or junction', () => {
      const parent = mkdtempSync(join(tmpdir(), 'anodex-workspace-'))
      const workspace = join(parent, 'workspace')
      const outside = join(parent, 'outside')
      mkdirSync(workspace)
      mkdirSync(outside)
      writeFileSync(join(outside, 'secret.txt'), 'secret')

      try {
        const link = join(workspace, 'linked-outside')
        symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')

        expect(() => resolveInWorkspace(workspace, 'linked-outside/secret.txt')).toThrow(
          /outside the workspace/
        )
      } finally {
        rmSync(parent, { recursive: true, force: true })
      }
    })

    it('allows a new nested path when its nearest existing parent is inside the workspace', () => {
      const parent = mkdtempSync(join(tmpdir(), 'anodex-workspace-'))
      const workspace = join(parent, 'workspace')
      mkdirSync(workspace)

      try {
        expect(resolveInWorkspace(workspace, 'new/nested/file.txt')).toBe(
          join(workspace, 'new', 'nested', 'file.txt')
        )
      } finally {
        rmSync(parent, { recursive: true, force: true })
      }
    })
  })

  describe('toWorkspaceRelative', () => {
    it('returns a forward-slashed relative path', () => {
      expect(toWorkspaceRelative(root, 'C:\\Users\\Owner\\workspace\\src\\index.ts')).toBe(
        'src/index.ts'
      )
    })

    it('returns "." for the workspace root', () => {
      expect(toWorkspaceRelative(root, 'C:\\Users\\Owner\\workspace')).toBe('.')
    })
  })
})
