/**
 * What an everyday folder name is for, whatever the provider calls it.
 *
 * Measured on 17 email questions: asked to trash or archive an email, Gemma 4
 * E4B and Llama 3.1 8B passed "trash" and "Archive", and the IMAP server's
 * folders were "[Gmail]/Trash" and "[Gmail]/All Mail", so every such move was
 * refused. Outlook says "Deleted Items" and "Junk Email"; Gmail's API says
 * "TRASH" and "SPAM". Each adapter maps a purpose onto its own names.
 */
export type FolderPurpose = 'trash' | 'archive' | 'spam' | 'sent' | 'drafts' | 'starred'

export function folderPurpose(name: string): FolderPurpose | null {
  return PURPOSES[name.trim().toLowerCase()] ?? null
}

const PURPOSES: Record<string, FolderPurpose> = {
  trash: 'trash',
  bin: 'trash',
  deleted: 'trash',
  'deleted items': 'trash',
  'deleted messages': 'trash',
  archive: 'archive',
  archived: 'archive',
  'all mail': 'archive',
  spam: 'spam',
  junk: 'spam',
  'junk email': 'spam',
  sent: 'sent',
  'sent mail': 'sent',
  'sent items': 'sent',
  drafts: 'drafts',
  draft: 'drafts',
  starred: 'starred',
  flagged: 'starred'
}

/** IMAP special-use attributes (RFC 6154) for each purpose, most specific first. */
export const IMAP_SPECIAL_USE: Record<FolderPurpose, readonly string[]> = {
  trash: ['\\Trash'],
  archive: ['\\Archive', '\\All'],
  spam: ['\\Junk'],
  sent: ['\\Sent'],
  drafts: ['\\Drafts'],
  starred: ['\\Flagged']
}

/** Microsoft Graph well-known folder names; it has no starred folder. */
export const GRAPH_WELL_KNOWN: Partial<Record<FolderPurpose, string>> = {
  trash: 'deleteditems',
  archive: 'archive',
  spam: 'junkemail',
  sent: 'sentitems',
  drafts: 'drafts'
}

/** Gmail API system label ids; archiving in Gmail is removing INBOX, not a label. */
export const GMAIL_SYSTEM_LABEL: Partial<Record<FolderPurpose, string>> = {
  trash: 'TRASH',
  spam: 'SPAM',
  sent: 'SENT',
  drafts: 'DRAFT',
  starred: 'STARRED'
}
