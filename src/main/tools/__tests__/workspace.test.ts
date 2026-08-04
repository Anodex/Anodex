import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveInWorkspace, toWorkspaceRelative } from '../workspace'

describe('workspace path safety', () => {
  /**
   * Built through `resolve` rather than written as a literal, so the
   * absolute-path cases below test what they mean to on every OS.
   *
   * A hardcoded `C:\Users\Owner\workspace` is only an absolute path on
   * Windows. On Linux and macOS `isAbsolute` says false, so the string is
   * treated as an ordinary relative name and joined *into* the workspace —
   * meaning the traversal guard was being asserted against a path that never
   * escaped in the first place. Those assertions did not merely fail off
   * Windows, they could not test the thing they exist to test.
   */
  const root = resolve('/anodex-test/workspace')
  const insideFile = join(root, 'src', 'index.ts')
  const outsideFile = resolve('/anodex-test-elsewhere/secrets.txt')

  describe('resolveInWorkspace', () => {
    it('resolves a relative path inside the workspace', () => {
      expect(resolveInWorkspace(root, 'src/index.ts')).toBe(insideFile)
    })

    it('resolves an absolute path inside the workspace', () => {
      expect(resolveInWorkspace(root, insideFile)).toBe(insideFile)
    })

    it('resolves the workspace root for "."', () => {
      expect(resolveInWorkspace(root, '.')).toBe(root)
    })

    it('blocks paths that escape the workspace via ..', () => {
      expect(() => resolveInWorkspace(root, '../secrets.txt')).toThrow(/outside the workspace/)
    })

    it('blocks absolute paths outside the workspace', () => {
      expect(() => resolveInWorkspace(root, outsideFile)).toThrow(/outside the workspace/)
    })

    // Kept as a real Windows case rather than folded into the portable ones
    // above: drive letters, backslash separators, and `C:\Windows` are the
    // shapes an escape attempt actually takes on the platform Anodex ships
    // on, and a POSIX-shaped fixture never exercises that parsing.
    describe.runIf(process.platform === 'win32')('Windows path semantics', () => {
      it('blocks a drive-absolute path outside the workspace', () => {
        expect(() =>
          resolveInWorkspace('C:\\Users\\Owner\\workspace', 'C:\\Windows\\system32\\notepad.exe')
        ).toThrow(/outside the workspace/)
      })

      it('resolves a backslash path inside the workspace', () => {
        expect(
          resolveInWorkspace(
            'C:\\Users\\Owner\\workspace',
            'C:\\Users\\Owner\\workspace\\src\\index.ts'
          )
        ).toBe('C:\\Users\\Owner\\workspace\\src\\index.ts')
      })
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

    it('blocks a link pointing outside at a file that does not exist yet', () => {
      // `realpathSync` throws ENOENT for a dangling link and `existsSync`
      // reports it as absent, so the confinement check used to skip straight
      // past it to the workspace directory and allow the path. Writing to the
      // returned path then creates the file wherever the link points —
      // verified on Windows: the bytes land outside the workspace.
      const parent = mkdtempSync(join(tmpdir(), 'anodex-workspace-'))
      const workspace = join(parent, 'workspace')
      const outside = join(parent, 'outside')
      mkdirSync(workspace)
      mkdirSync(outside)

      try {
        symlinkSync(join(outside, 'planted.txt'), join(workspace, 'notes.txt'), 'file')

        expect(() => resolveInWorkspace(workspace, 'notes.txt')).toThrow(/outside the workspace/)
      } finally {
        rmSync(parent, { recursive: true, force: true })
      }
    })

    // This and the cycle case below pass against the pre-fix file too, which
    // allowed everything of this shape. They are not evidence of a fix; they
    // guard the hand-rolled link following that replaced it from over-blocking
    // or spinning.
    it('still allows a link pointing at a not-yet-created file inside the workspace', () => {
      // The fix must confine, not ban links — one pointing back into the
      // workspace is ordinary and has to keep working.
      const parent = mkdtempSync(join(tmpdir(), 'anodex-workspace-'))
      const workspace = join(parent, 'workspace')
      mkdirSync(workspace)
      mkdirSync(join(workspace, 'real'))

      try {
        symlinkSync(join(workspace, 'real', 'pending.txt'), join(workspace, 'notes.txt'), 'file')

        expect(resolveInWorkspace(workspace, 'notes.txt')).toBe(join(workspace, 'notes.txt'))
      } finally {
        rmSync(parent, { recursive: true, force: true })
      }
    })

    it('follows a chain of links to where it actually lands', () => {
      // One hop inside the workspace, the next outside. Checking only the
      // first hop would clear this as "still in the workspace".
      const parent = mkdtempSync(join(tmpdir(), 'anodex-workspace-'))
      const workspace = join(parent, 'workspace')
      const outside = join(parent, 'outside')
      mkdirSync(workspace)
      mkdirSync(outside)

      try {
        symlinkSync(join(outside, 'planted.txt'), join(workspace, 'b.txt'), 'file')
        symlinkSync(join(workspace, 'b.txt'), join(workspace, 'a.txt'), 'file')

        expect(() => resolveInWorkspace(workspace, 'a.txt')).toThrow(/outside the workspace/)
      } finally {
        rmSync(parent, { recursive: true, force: true })
      }
    })

    it('does not hang on a link that points at itself', () => {
      const parent = mkdtempSync(join(tmpdir(), 'anodex-workspace-'))
      const workspace = join(parent, 'workspace')
      mkdirSync(workspace)

      try {
        symlinkSync(join(workspace, 'b.txt'), join(workspace, 'a.txt'), 'file')
        symlinkSync(join(workspace, 'a.txt'), join(workspace, 'b.txt'), 'file')

        // Whatever it decides, it has to decide — a cycle must not spin.
        expect(() => resolveInWorkspace(workspace, 'a.txt')).not.toThrow(/Maximum call stack/)
      } finally {
        rmSync(parent, { recursive: true, force: true })
      }
    })

    it('warns and falls back to lexical confinement when the workspace root cannot be resolved', () => {
      // A workspace root that does not exist on disk makes realpathSync.native
      // throw — the lexical ".."/absolute checks in resolveInWorkspace/
      // isPathInside still ran first and already passed, so this only
      // exercises assertRealPathInside's own catch path.
      const missingRoot = join(tmpdir(), 'anodex-missing-root-does-not-exist')
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        expect(resolveInWorkspace(missingRoot, 'src/index.ts')).toBe(
          join(missingRoot, 'src', 'index.ts')
        )
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('[workspace]'),
          expect.stringContaining('symlink confinement checks are'),
          expect.anything()
        )
      } finally {
        warn.mockRestore()
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
      expect(toWorkspaceRelative(root, insideFile)).toBe('src/index.ts')
    })

    it('returns "." for the workspace root', () => {
      expect(toWorkspaceRelative(root, root)).toBe('.')
    })

    // The forward-slashing is only observable where the separator differs.
    it.runIf(process.platform === 'win32')('converts Windows separators to forward slashes', () => {
      expect(
        toWorkspaceRelative(
          'C:\\Users\\Owner\\workspace',
          'C:\\Users\\Owner\\workspace\\src\\index.ts'
        )
      ).toBe('src/index.ts')
    })
  })
})
