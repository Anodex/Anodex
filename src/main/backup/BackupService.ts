import { app, BrowserWindow, dialog } from 'electron'
import { cp, mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Conversation } from '@shared/conversation.types'
import type { BackupResult, ConversationExportFormat } from '@shared/backup.types'
import { conversationToMarkdown, exportFileStem } from '@shared/conversationExport'
import { classifyExclusion, shouldBackUp, type BackupExclusion } from './backupPaths'
import { createLogger } from '../utils/logger'

const log = createLogger('backup')

/** `YYYY-MM-DD-HHmm`, so successive backups sort and never collide. */
function timestampFolderName(now = new Date()): string {
  const iso = now.toISOString()
  return `anodex-backup-${iso.slice(0, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}`
}

/**
 * Write one conversation to a file the user chooses.
 *
 * Markdown is for reading and keeping; JSON is the same `Conversation` object
 * the app itself persists, so nothing is lost in translation and a future
 * import has something exact to work from.
 */
export async function exportConversation(
  parent: BrowserWindow | null,
  conversation: Conversation,
  format: ConversationExportFormat
): Promise<string | null> {
  const extension = format === 'markdown' ? 'md' : 'json'
  const options = {
    title: 'Export chat',
    defaultPath: join(app.getPath('documents'), `${exportFileStem(conversation)}.${extension}`),
    filters: [
      format === 'markdown'
        ? { name: 'Markdown', extensions: ['md'] }
        : { name: 'JSON', extensions: ['json'] }
    ]
  }
  const selection = parent
    ? await dialog.showSaveDialog(parent, options)
    : await dialog.showSaveDialog(options)
  if (selection.canceled || !selection.filePath) return null

  const filePath = selection.filePath.toLowerCase().endsWith(`.${extension}`)
    ? selection.filePath
    : `${selection.filePath}.${extension}`

  const contents =
    format === 'markdown'
      ? conversationToMarkdown(conversation)
      : `${JSON.stringify(conversation, null, 2)}\n`
  await writeFile(filePath, contents, 'utf-8')
  return filePath
}

/**
 * Copy every store in `userData` into a timestamped folder the user picks.
 *
 * Deliberately a plain copy rather than an archive: no zip dependency, and
 * the result stays inspectable and restorable by hand with the app closed,
 * which is the recovery path that has to work when nothing else does.
 *
 * Nothing is deleted or moved, so this is safe to run at any time — including
 * while the app is busy. A store written mid-copy lands as whichever version
 * happened to be on disk; every store here writes atomically or whole-file,
 * so a torn read isn't a concern, but a backup taken during a generation may
 * miss that turn.
 */
export async function backupUserData(parent: BrowserWindow | null): Promise<BackupResult | null> {
  const options = {
    title: 'Choose where to save the backup',
    defaultPath: app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
    buttonLabel: 'Back up here'
  }
  const selection = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options)
  if (selection.canceled || selection.filePaths.length === 0) return null

  const source = app.getPath('userData')
  // Always a fresh subfolder — writing straight into the chosen directory
  // would mix Anodex's stores into whatever else lives there and make the
  // backup impossible to identify later.
  const destination = join(selection.filePaths[0], timestampFolderName())
  await mkdir(destination, { recursive: true })

  const entries = await readdir(source, { withFileTypes: true })
  const copied: string[] = []
  const skipped: BackupExclusion[] = []

  for (const entry of entries) {
    if (!shouldBackUp(entry.name)) {
      const exclusion = classifyExclusion(entry.name)
      if (exclusion) skipped.push(exclusion)
      continue
    }
    try {
      await cp(join(source, entry.name), join(destination, entry.name), {
        recursive: true,
        // A store being rewritten as we read it shouldn't abort the whole
        // backup; better to finish and report than to leave nothing.
        force: true
      })
      copied.push(entry.name)
    } catch (error) {
      log.warn('Skipped during backup:', entry.name, error)
    }
  }

  log.info('Backed up', copied.length, 'stores to', destination)
  return { path: destination, copied, skipped }
}
