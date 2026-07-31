/**
 * What belongs in a backup of Anodex's data directory, and what emphatically
 * does not.
 *
 * The backup is a plain recursive copy of `userData` rather than a bundle
 * format of Anodex's own invention. That is deliberate: there are seventeen
 * separate stores in there and more arrive with every feature, so any
 * hand-maintained schema would silently start missing things the moment
 * someone added a store and forgot to update the exporter. A copy cannot
 * develop that particular blind spot, and it stays restorable by hand — drop
 * the folder back with the app closed — which matters more than elegance for
 * something whose whole job is to work on the worst day.
 *
 * Pure: this decides names only. `BackupService` does the I/O.
 */

/**
 * Chromium and Electron runtime state. All of it is regenerated on launch,
 * none of it is the user's, and some of it (the lockfile especially) actively
 * breaks a restored copy.
 */
const RUNTIME_NAMES = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'blob_storage',
  'Network',
  'DIPS',
  'Local Storage',
  'Session Storage',
  'Shared Dictionary',
  'SharedStorage',
  'Local State',
  'Preferences',
  'DevToolsActivePort',
  'lockfile'
])

/**
 * Downloaded model weights. A single GGUF runs to gigabytes and a models
 * directory can hold tens of them — copying that into a backup would turn a
 * quick safety net into an overnight job filling the user's disk with bytes
 * they can re-download for free. This is the one exclusion a user might not
 * expect, so it has to be stated in the UI rather than just done.
 */
const REDOWNLOADABLE_NAMES = new Set(['models'])

export interface BackupExclusion {
  name: string
  reason: 'runtime' | 'redownloadable'
}

/** Whether a top-level entry of `userData` belongs in a backup. */
export function shouldBackUp(name: string): boolean {
  return !RUNTIME_NAMES.has(name) && !REDOWNLOADABLE_NAMES.has(name)
}

/** Why each skipped entry was skipped, for reporting after a backup runs. */
export function classifyExclusion(name: string): BackupExclusion | null {
  if (RUNTIME_NAMES.has(name)) return { name, reason: 'runtime' }
  if (REDOWNLOADABLE_NAMES.has(name)) return { name, reason: 'redownloadable' }
  return null
}

/**
 * Files whose contents are encrypted with the OS keystore (`safeStorage`) and
 * are therefore bound to this machine and user account. They are copied — a
 * restore onto the *same* machine wants them — but they will not decrypt
 * anywhere else, so a backup carried to a new machine needs its API keys and
 * mailbox logins entered again. Callers surface this rather than letting the
 * user discover it when a restore silently can't reach their mail.
 */
export const MACHINE_BOUND_NAMES = ['settings.json', 'email-auth.json', 'mcp-auth.json']
