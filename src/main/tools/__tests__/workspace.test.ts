import { describe, expect, it } from 'vitest'
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
