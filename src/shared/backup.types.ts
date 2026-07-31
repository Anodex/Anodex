/** Exporting a conversation, and backing up the whole data directory. */

/**
 * `markdown` is the readable form — what you'd keep or send to someone.
 * `json` is the persisted `Conversation` verbatim, so nothing is lost.
 */
export type ConversationExportFormat = 'markdown' | 'json'

/** Why a top-level store was left out of a backup. */
export interface BackupExclusionInfo {
  name: string
  /** `runtime`: Chromium state, regenerated on launch. `redownloadable`: model weights. */
  reason: 'runtime' | 'redownloadable'
}

export interface BackupResult {
  /** Absolute path of the timestamped folder that was written. */
  path: string
  /** Top-level store names copied into it. */
  copied: string[]
  /** Entries deliberately left out, with the reason. */
  skipped: BackupExclusionInfo[]
}
