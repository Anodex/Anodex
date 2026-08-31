/**
 * Turn a filesystem failure into something a model can act on.
 *
 * Anodex's own refusals read well — "Path is outside the workspace and was
 * blocked", "Path is not a file", "oldText was not found. Do not guess at it".
 * A failure that reaches the model straight from Node does not: it arrives as
 * `ENOENT: no such file or directory, stat 'C:\Users\...\project\gone.py'`,
 * which names an errno, repeats the host's absolute path, and says nothing
 * about what to do next.
 *
 * That costs three things. The jargon is noise; the absolute path is noise the
 * user's machine leaks into the transcript; and on a small window both are
 * spent out of the same working room a file read needs — measured at about
 * 4,750 tokens at an 8,192 window, where a couple of these matter.
 *
 * Deliberately not a catch-all. Only the conditions with a clear next action
 * are rewritten; anything else keeps its original message, because a wrong
 * explanation is worse than a raw one.
 */
export function describeWorkspaceError(error: unknown, workspaceRelativePath: string): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code

  if (code === 'ENOENT') {
    return (
      `${workspaceRelativePath} does not exist in this workspace. ` +
      'Use list_directory or find_files to see what is actually there, rather than guessing at ' +
      'the path.'
    )
  }

  if (code === 'EISDIR') {
    return `${workspaceRelativePath} is a directory, not a file. Use list_directory to see inside it.`
  }

  if (code === 'EACCES' || code === 'EPERM') {
    return (
      `${workspaceRelativePath} could not be opened — the operating system refused access. ` +
      'Another program may be holding it, or its permissions may not allow reading.'
    )
  }

  if (code === 'EMFILE' || code === 'ENFILE') {
    return (
      'Too many files are open at once to read this. This is a limit on the machine rather ' +
      'than a problem with the file; retrying usually succeeds.'
    )
  }

  return error instanceof Error ? error.message : String(error)
}
