import { dialog, ipcMain, shell } from 'electron'
import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { IpcChannel } from '@shared/ipc'
import { ok, err, toErrorMessage } from '@shared/result'
import type {
  EmailConnectOAuthRequest,
  EmailConnectPasswordRequest,
  EmailDraftRequest,
  EmailFlagRequest,
  EmailListThreadsRequest,
  EmailMoveRequest,
  EmailSearchRequest,
  EmailSendRequest,
  EmailSyncMode,
  EmailThreadDigestRequest
} from '@shared/email.types'
import { emailService } from '../email/EmailService'
import { digestThreads } from '../email/threadDigests'
import { loadRemoteImages } from '../email/remoteImages'
import { createLogger } from '../utils/logger'

const log = createLogger('ipc:email')

/** Where "Open webmail" goes for each provider. */
const WEBMAIL_URLS: Record<string, string> = {
  gmail: 'https://mail.google.com/',
  microsoft: 'https://outlook.live.com/mail/'
}

/**
 * A sender-supplied attachment name reduced to something safe to suggest.
 *
 * Takes the last path segment under both separator conventions — a Windows
 * build must not treat `..\evil.txt` as a plain name just because POSIX
 * `basename` does not split on a backslash — and falls back when what is left
 * is empty, a dot entry, or a bare Windows drive.
 */
function suggestedFileName(filename: string): string {
  const lastSegment = basename(String(filename ?? '').replace(/\\/g, '/')).trim()
  const unusable =
    !lastSegment || lastSegment === '.' || lastSegment === '..' || /^[A-Za-z]:$/.test(lastSegment)
  return unusable ? 'attachment' : lastSegment
}

export function registerEmailHandlers(): void {
  ipcMain.handle(IpcChannel.Email.getStatus, () => ok(emailService.getStatus()))

  ipcMain.handle(IpcChannel.Email.listAccounts, () => ok(emailService.listAccounts()))

  ipcMain.handle(IpcChannel.Email.openWebmail, async (_event, accountId?: string) => {
    try {
      const status = emailService.getStatus()
      // Scoped to the account being viewed. `status.provider` is the *primary*
      // account's — the fields around it say so — and this used to read it with
      // no account at all, so a Gmail primary alongside an Outlook secondary
      // opened Gmail however carefully the reader had selected Outlook first.
      // With an IMAP primary it refused outright, naming a provider the reader
      // was not looking at.
      const account = accountId
        ? status.accounts.find((candidate) => candidate.id === accountId)
        : undefined
      const provider = account?.provider ?? status.provider
      const url = WEBMAIL_URLS[provider]
      if (!url) {
        return err(
          'email.no-webmail',
          'That account has no web interface Anodex can open.',
          `Provider: ${provider}`
        )
      }
      await shell.openExternal(url)
      return ok(undefined)
    } catch (error) {
      log.warn('Failed to open webmail:', error)
      return err('email.open-web-failed', 'Could not open webmail.', toErrorMessage(error))
    }
  })

  ipcMain.handle(IpcChannel.Email.discover, async (_event, address: string) => {
    try {
      return ok(await emailService.discover(address))
    } catch (error) {
      log.warn('Failed to discover email settings:', error)
      return err(
        'email.discover-failed',
        'Could not work out the settings for that address.',
        toErrorMessage(error)
      )
    }
  })

  ipcMain.handle(
    IpcChannel.Email.connectOAuth,
    async (_event, request: EmailConnectOAuthRequest) => {
      try {
        return ok(await emailService.connectOAuth(request))
      } catch (error) {
        log.warn('Failed to connect an OAuth email account:', error)
        return err('email.connect-failed', 'Could not connect that account.', toErrorMessage(error))
      }
    }
  )

  ipcMain.handle(
    IpcChannel.Email.connectPassword,
    async (_event, request: EmailConnectPasswordRequest) => {
      try {
        return ok(await emailService.connectPassword(request))
      } catch (error) {
        log.warn('Failed to connect an IMAP email account:', error)
        return err('email.connect-failed', 'Could not connect that account.', toErrorMessage(error))
      }
    }
  )

  ipcMain.handle(IpcChannel.Email.removeAccount, (_event, accountId: string) => {
    try {
      return ok(emailService.removeAccount(accountId))
    } catch (error) {
      log.warn('Failed to remove an email account:', error)
      return err('email.remove-failed', 'Could not unlink that account.', toErrorMessage(error))
    }
  })

  ipcMain.handle(IpcChannel.Email.setPrimaryAccount, (_event, accountId: string) => {
    try {
      return ok(emailService.setPrimaryAccount(accountId))
    } catch (error) {
      log.warn('Failed to set the primary email account:', error)
      return err(
        'email.set-primary-failed',
        'Could not change the default account.',
        toErrorMessage(error)
      )
    }
  })

  ipcMain.handle(
    IpcChannel.Email.setSyncMode,
    (_event, accountId: string, syncMode: EmailSyncMode) => {
      try {
        return ok(emailService.setSyncMode(accountId, syncMode))
      } catch (error) {
        log.warn('Failed to change email sync mode:', error)
        return err(
          'email.sync-mode-failed',
          'Could not change the sync scope.',
          toErrorMessage(error)
        )
      }
    }
  )

  ipcMain.handle(IpcChannel.Email.getUnreadThreadCount, async (_event, accountId?: string) => {
    try {
      return ok(await emailService.getUnreadThreadCount(accountId))
    } catch (error) {
      log.warn('Failed to count unread email threads:', error)
      return err(
        'email.unread-count-failed',
        'Could not count unread email threads.',
        toErrorMessage(error)
      )
    }
  })

  ipcMain.handle(IpcChannel.Email.listThreads, async (_event, request: EmailListThreadsRequest) => {
    try {
      return ok(await emailService.listThreads(request))
    } catch (error) {
      log.warn('Failed to list email threads:', error)
      return err('email.list-failed', 'Could not list email threads.', toErrorMessage(error))
    }
  })

  ipcMain.handle(IpcChannel.Email.search, async (_event, request: EmailSearchRequest) => {
    try {
      return ok(await emailService.search(request))
    } catch (error) {
      log.warn('Failed to search email:', error)
      return err('email.search-failed', 'Could not search email.', toErrorMessage(error))
    }
  })

  ipcMain.handle(IpcChannel.Email.readMessage, async (_event, id: string, accountId?: string) => {
    try {
      return ok(await emailService.readMessage(id, accountId))
    } catch (error) {
      log.warn('Failed to read email message:', error)
      return err('email.read-failed', 'Could not read email message.', toErrorMessage(error))
    }
  })

  ipcMain.handle(
    IpcChannel.Email.getThreadMessages,
    async (_event, threadId: string, accountId?: string) => {
      try {
        return ok(await emailService.getThreadMessages(threadId, accountId))
      } catch (error) {
        log.warn('Failed to read an email thread:', error)
        return err(
          'email.thread-failed',
          'Could not open that conversation.',
          toErrorMessage(error)
        )
      }
    }
  )

  ipcMain.handle(IpcChannel.Email.loadRemoteImages, async (_event, urls: string[]) => {
    try {
      return ok(await loadRemoteImages(Array.isArray(urls) ? urls : []))
    } catch (error) {
      // Images are an enhancement to a message that reads fine without them.
      log.warn('Failed to load remote images:', error)
      return ok({})
    }
  })

  ipcMain.handle(
    IpcChannel.Email.digestThreads,
    async (_event, requests: EmailThreadDigestRequest[]) => {
      try {
        return ok(await digestThreads(requests))
      } catch (error) {
        // Digests are an enhancement to a list that renders fine without them,
        // so a failure here is worth a log and nothing louder. It still comes
        // back as a failed pass rather than an empty one — the list has no
        // other way to tell this apart from an inbox with nothing left to do.
        log.warn('Failed to digest email threads:', error)
        return ok({ digests: [], outcome: 'failed', abandonedThreadIds: [] })
      }
    }
  )

  ipcMain.handle(IpcChannel.Email.applyFlag, async (_event, request: EmailFlagRequest) => {
    try {
      return ok(await emailService.applyFlag(request))
    } catch (error) {
      log.warn('Failed to change email state:', error)
      return err('email.flag-failed', 'Could not update that message.', toErrorMessage(error))
    }
  })

  ipcMain.handle(IpcChannel.Email.move, async (_event, request: EmailMoveRequest) => {
    try {
      return ok(await emailService.move(request))
    } catch (error) {
      log.warn('Failed to move email:', error)
      return err('email.move-failed', 'Could not move that message.', toErrorMessage(error))
    }
  })

  ipcMain.handle(IpcChannel.Email.listMailboxes, async (_event, accountId?: string) => {
    try {
      return ok(await emailService.listMailboxes(accountId))
    } catch (error) {
      log.warn('Failed to list mailboxes:', error)
      return err('email.mailboxes-failed', 'Could not list mailboxes.', toErrorMessage(error))
    }
  })

  ipcMain.handle(
    IpcChannel.Email.saveAttachment,
    async (
      _event,
      request: {
        messageId: string
        attachmentId: string
        filename: string
        accountId?: string
      }
    ) => {
      try {
        // Ask before fetching: a cancelled dialog should cost nothing, and the
        // user picking the destination is what makes writing a file here safe.
        //
        // The suggested name is reduced to its last segment first. `filename`
        // is chosen by whoever sent the mail, and it was being handed to
        // `defaultPath` whole — so an attachment named `..\..\settings.json`,
        // or an absolute path, opened the dialog pointed somewhere the reader
        // never navigated to. They still have to press Save, but the dialog is
        // meant to be where they choose the destination, not where a sender
        // does.
        const { canceled, filePath } = await dialog.showSaveDialog({
          defaultPath: suggestedFileName(request.filename),
          title: 'Save attachment'
        })
        if (canceled || !filePath) return ok({ path: null })

        const attachment = await emailService.getAttachment(
          request.messageId,
          request.attachmentId,
          request.accountId
        )
        await writeFile(filePath, attachment.data)
        return ok({ path: filePath })
      } catch (error) {
        log.warn('Failed to save an email attachment:', error)
        return err(
          'email.attachment-failed',
          'Could not save that attachment.',
          toErrorMessage(error)
        )
      }
    }
  )

  ipcMain.handle(IpcChannel.Email.createDraft, (_event, request: EmailDraftRequest) => {
    try {
      return ok(emailService.createDraft(request))
    } catch (error) {
      log.warn('Failed to create email draft:', error)
      return err('email.draft-failed', 'Could not create email draft.', toErrorMessage(error))
    }
  })

  ipcMain.handle(IpcChannel.Email.send, async (_event, request: EmailSendRequest) => {
    try {
      await emailService.send(request)
      return ok(undefined)
    } catch (error) {
      log.warn('Failed to send email:', error)
      return err('email.send-failed', 'Could not send email.', toErrorMessage(error))
    }
  })
}
