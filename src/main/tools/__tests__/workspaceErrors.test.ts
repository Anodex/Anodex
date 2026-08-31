import { describe, expect, it } from 'vitest'
import { describeWorkspaceError } from '../workspaceErrors'

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(
    `${code}: no such file or directory, stat 'C:\\Users\\Owner\\project\\gone.py'`
  ) as NodeJS.ErrnoException
  error.code = code
  return error
}

describe('describeWorkspaceError', () => {
  // The raw message names an errno, repeats the host's absolute path, and says
  // nothing about what to do - and on an 8,192 window it is spent out of the
  // same ~4,750 tokens a file read needs.
  it('says what is missing and what to do instead', () => {
    const message = describeWorkspaceError(errno('ENOENT'), 'src/gone.py')

    expect(message).toContain('src/gone.py')
    expect(message).toContain('does not exist')
    expect(message).toMatch(/list_directory|find_files/)
  })

  it('drops the errno and the host path', () => {
    const message = describeWorkspaceError(errno('ENOENT'), 'src/gone.py')

    expect(message).not.toContain('ENOENT')
    expect(message).not.toContain('C:\\Users')
  })

  it('tells a directory from a file', () => {
    expect(describeWorkspaceError(errno('EISDIR'), 'src')).toContain('is a directory')
  })

  it('separates a permission refusal from a missing file', () => {
    const message = describeWorkspaceError(errno('EACCES'), 'src/locked.py')

    expect(message).toContain('refused access')
    expect(message).not.toContain('does not exist')
  })

  it('says a file-handle limit is the machine, not the file', () => {
    expect(describeWorkspaceError(errno('EMFILE'), 'a.py')).toContain('limit on the machine')
  })

  // A wrong explanation is worse than a raw one, so anything unrecognised keeps
  // its own message rather than being flattened into a guess.
  it('leaves an unrecognised failure exactly as it was', () => {
    const odd = new Error('something the filesystem has never done before')

    expect(describeWorkspaceError(odd, 'a.py')).toBe(
      'something the filesystem has never done before'
    )
  })

  it('handles a thrown non-error without inventing anything', () => {
    expect(describeWorkspaceError('just a string', 'a.py')).toBe('just a string')
  })
})
