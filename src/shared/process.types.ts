/** A process Anodex started in the background for a project, as the UI shows it. */
export interface BackgroundProcessInfo {
  id: string
  /** A short name: the one given, or the command's first words. */
  name: string
  command: string
  projectId: string | null
  conversationId: string | null
  /** The workspace folder it was started in. */
  cwd: string
  startedAt: number
  status: 'running' | 'exited' | 'stopped' | 'failed'
  /** Exit code once it has ended on its own; null while running or when killed. */
  exitCode: number | null
  endedAt: number | null
  /** The first local web address it printed, if any (a dev server's URL). */
  url: string | null
}
