import { ipcMain, shell } from 'electron'
import { IpcChannel } from '@shared/ipc'
import { ok, err, toErrorMessage } from '@shared/result'
import type {
  EmailDraftRequest,
  EmailListThreadsRequest,
  EmailSearchRequest,
  EmailSendRequest
} from '@shared/email.types'
import { emailService } from '../email/EmailService'
import { createLogger } from '../utils/logger'

const log = createLogger('ipc:email')

export function registerEmailHandlers(): void {
  ipcMain.handle(IpcChannel.Email.getStatus, () => ok(emailService.getStatus()))

  ipcMain.handle(IpcChannel.Email.openGmailWeb, async () => {
    try {
      await shell.openExternal('https://mail.google.com/')
      return ok(undefined)
    } catch (error) {
      log.warn('Failed to open Gmail web:', error)
      return err('email.open-web-failed', 'Could not open Gmail in the browser.', toErrorMessage(error))
    }
  })

  ipcMain.handle(IpcChannel.Email.connectGmail, async () => {
    try {
      return ok(await emailService.connectGmail())
    } catch (error) {
      log.warn('Failed to connect Gmail:', error)
      return err('email.connect-failed', 'Could not connect Gmail.', toErrorMessage(error))
    }
  })

  ipcMain.handle(IpcChannel.Email.disconnectGmail, () => {
    try {
      return ok(emailService.disconnectGmail())
    } catch (error) {
      log.warn('Failed to disconnect Gmail:', error)
      return err('email.disconnect-failed', 'Could not disconnect Gmail.', toErrorMessage(error))
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

  ipcMain.handle(IpcChannel.Email.readMessage, async (_event, id: string) => {
    try {
      return ok(await emailService.readMessage(id))
    } catch (error) {
      log.warn('Failed to read email message:', error)
      return err('email.read-failed', 'Could not read email message.', toErrorMessage(error))
    }
  })

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
