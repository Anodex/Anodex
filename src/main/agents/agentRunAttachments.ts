import { app } from 'electron'
import { join } from 'node:path'
import { copyFile, mkdir, rm } from 'node:fs/promises'
import { MAX_RUN_ATTACHMENTS, type AgentRunAttachmentRequest } from '@shared/agentRun.types'
import type { ChatAttachment, ChatHistoryTurn, ChatImageInput } from '@shared/chat.types'
import { MAX_VISION_IMAGES, reopenChatImage } from '../vision/imageInputs'
import { readAttachmentFile } from '../ipc/attachments.handlers'
import { createLogger } from '../utils/logger'
import { withRunAttachments, type RunAttachmentText } from './agentPrompts'

const log = createLogger('agent-run-attachments')

/** Where one run keeps its copies. Under `userData`, never the project. */
export function runAttachmentsDirectory(runId: string): string {
  return join(app.getPath('userData'), 'agent-runs', 'attachments', runId)
}

/** The punctuation Windows reserves in a filename; control characters are handled apart. */
const RESERVED_FILENAME_CHARS = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*'])

/** A filename Windows, macOS and Linux all accept, kept recognisable. */
export function safeAttachmentFileName(name: string): string {
  const cleaned = Array.from(name)
    .map((char) => (char.charCodeAt(0) < 32 || RESERVED_FILENAME_CHARS.has(char) ? '_' : char))
    .join('')
    .trim()
  return cleaned.length > 0 ? cleaned.slice(0, 120) : 'attachment'
}

/**
 * Validate the files offered to a new run and copy them into the run.
 *
 * Validation is the chat composer's own (`readAttachmentFile`), so a file a
 * chat message would refuse is refused here too, and with the same words. It
 * runs before anything is copied: a run that cannot have what it was promised
 * should not start at all, rather than start without it and say nothing.
 *
 * Copies rather than references — see `AgentRun.attachments`. A partial copy is
 * removed before the error is thrown, so a refused start leaves nothing behind.
 */
export async function importRunAttachments(
  runId: string,
  requested: readonly AgentRunAttachmentRequest[]
): Promise<ChatAttachment[]> {
  if (requested.length === 0) return []
  if (requested.length > MAX_RUN_ATTACHMENTS) {
    throw new Error(`A run can be given at most ${MAX_RUN_ATTACHMENTS} files.`)
  }

  const checked: { request: AgentRunAttachmentRequest; attachment: ChatAttachment }[] = []
  for (const request of requested) {
    const read = await readAttachmentFile(request.path)
    if (!read.ok) throw new Error(`Could not attach "${request.name}": ${read.error.message}`)
    const content = read.value
    checked.push({
      request,
      attachment:
        content.kind === 'image'
          ? {
              path: request.path,
              name: request.name,
              sizeBytes: content.sizeBytes,
              kind: 'image',
              mimeType: content.mimeType,
              // Pinned so vision providers reopen it on every later turn, not
              // just the one that introduced it — see `ChatAttachment`. A
              // reference image the run stops seeing after turn one is not a
              // reference.
              visionContextPinned: true
            }
          : { path: request.path, name: request.name, sizeBytes: content.sizeBytes, kind: 'text' }
    })
  }
  const images = checked.filter(({ attachment }) => attachment.kind === 'image').length
  if (images > MAX_VISION_IMAGES) {
    throw new Error(`A run can be given at most ${MAX_VISION_IMAGES} images.`)
  }

  const directory = runAttachmentsDirectory(runId)
  try {
    await mkdir(directory, { recursive: true })
    const copies: ChatAttachment[] = []
    for (const [index, { request, attachment }] of checked.entries()) {
      // Indexed, so two files that share a name cannot overwrite each other.
      const copyPath = join(directory, `${index + 1}-${safeAttachmentFileName(request.name)}`)
      await copyFile(request.path, copyPath)
      copies.push({ ...attachment, path: copyPath })
    }
    return copies
  } catch (error) {
    await discardRunAttachments(runId)
    throw new Error(
      `Could not copy the attached files into the run: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}

/** Remove a run's copies. Never throws — a missing folder is already the goal. */
export async function discardRunAttachments(runId: string): Promise<void> {
  try {
    await rm(runAttachmentsDirectory(runId), { recursive: true, force: true })
  } catch (error) {
    log.warn('Could not remove attachments for agent run:', runId, error)
  }
}

/** What one turn sends because of the run's attachments. */
export interface TurnAttachments {
  /** Recorded on this turn's user message, so later turns reopen them from history. */
  attachments: ChatAttachment[] | undefined
  /** This turn's prompt, with any text attachments folded in. */
  prompt: string
  /** Image inputs sent with this turn. */
  images: ChatImageInput[]
}

/**
 * Decide what a turn carries, given the history it is about to send.
 *
 * One rule covers every case: if that history does not already hold the run's
 * attachments, this turn's message carries them. That is turn one, and it is
 * also the first turn after a context epoch has dropped the message that did —
 * which is exactly where a small window would otherwise lose the reference
 * images a run was started with. Every other turn sends nothing extra, because
 * the pinned attachments already in history are reopened by the provider.
 *
 * A copy that has gone missing is skipped with a warning rather than failing
 * the turn; the goal is still worth working on without it.
 */
export async function attachmentsForTurn(
  runAttachments: readonly ChatAttachment[] | undefined,
  history: readonly ChatHistoryTurn[],
  prompt: string
): Promise<TurnAttachments> {
  const owned = runAttachments ?? []
  // Matched by path, not by "any attachment": a file somebody attached to a
  // message typed into the run's chat is theirs, and must not stand in for the
  // run's own.
  const ownedPaths = new Set(owned.map((attachment) => attachment.path))
  const carried = history.some(
    (turn) =>
      turn.role === 'user' &&
      (turn.attachments ?? []).some((attachment) => ownedPaths.has(attachment.path))
  )
  if (owned.length === 0 || carried) return { attachments: undefined, prompt, images: [] }

  const images: ChatImageInput[] = []
  const texts: RunAttachmentText[] = []
  for (const attachment of owned) {
    if (attachment.kind === 'image') {
      const image = await reopenChatImage(attachment)
      if (image) images.push(image)
      else log.warn('Agent run image attachment is no longer readable:', attachment.path)
      continue
    }
    const read = await readAttachmentFile(attachment.path)
    if (read.ok && read.value.kind === 'text') {
      texts.push({
        name: attachment.name,
        content: read.value.content,
        truncated: read.value.truncated,
        sizeBytes: read.value.sizeBytes
      })
    } else {
      log.warn('Agent run text attachment is no longer readable:', attachment.path)
    }
  }

  return {
    attachments: [...owned],
    prompt: withRunAttachments(
      prompt,
      images.map((image) => image.name),
      texts
    ),
    images
  }
}
