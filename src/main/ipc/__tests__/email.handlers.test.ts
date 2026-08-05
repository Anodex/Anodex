import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IpcChannel } from '@shared/ipc'
import type { EmailConnectionStatus } from '@shared/email.types'

/**
 * First coverage for the renderer's entire entry point into mail. The file is
 * a uniform wall of try/catch → ok/err, so the interesting behaviour is the
 * small amount that is not: which account "Open webmail" resolves, and what a
 * sender-chosen attachment name is allowed to do to a Save dialog.
 *
 * Handlers are captured from a fake `ipcMain` and invoked directly.
 */

type Handler = (event: unknown, ...args: never[]) => unknown
const handlers = new Map<string, Handler>()

const openExternal = vi.fn<(url: string) => Promise<void>>()
const showSaveDialog = vi.fn<(options: { defaultPath?: string }) => Promise<unknown>>()
const writeFile = vi.fn<() => Promise<void>>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler)
  },
  shell: { openExternal: (url: string) => openExternal(url) },
  dialog: { showSaveDialog: (options: { defaultPath?: string }) => showSaveDialog(options) }
}))

vi.mock('node:fs/promises', () => ({ writeFile: () => writeFile() }))

const getStatus = vi.fn<() => EmailConnectionStatus>()
const getAttachment = vi.fn<() => Promise<{ data: Buffer; filename: string }>>()

vi.mock('../../email/EmailService', () => ({
  emailService: {
    getStatus: () => getStatus(),
    getAttachment: () => getAttachment()
  }
}))
vi.mock('../../email/threadDigests', () => ({ digestThreads: vi.fn() }))
vi.mock('../../email/remoteImages', () => ({ loadRemoteImages: vi.fn() }))

const { registerEmailHandlers } = await import('../email.handlers')

function status(overrides: Partial<EmailConnectionStatus> = {}): EmailConnectionStatus {
  return {
    enabled: true,
    connected: true,
    accounts: [],
    primaryAccountId: 'gmail-1',
    address: 'user@gmail.com',
    provider: 'gmail',
    syncMode: 'metadata',
    sendRequiresApproval: true,
    ...overrides
  }
}

function account(id: string, provider: EmailConnectionStatus['provider']) {
  return {
    id,
    provider: provider as 'gmail' | 'microsoft' | 'imap',
    address: `${id}@example.com`,
    displayName: id,
    connected: true,
    isPrimary: false
  }
}

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`No handler registered for ${channel}`)
  return Promise.resolve(handler({}, ...(args as never[])))
}

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  openExternal.mockResolvedValue(undefined)
  writeFile.mockResolvedValue(undefined)
  registerEmailHandlers()
})

describe('openWebmail', () => {
  /**
   * `status.provider` is the *primary* account's, which is what this used to
   * read with no account at all — so a Gmail primary alongside an Outlook
   * secondary opened Gmail however carefully Outlook had been selected.
   */
  it('opens the webmail of the account being viewed, not the primary', async () => {
    getStatus.mockReturnValue(
      status({
        provider: 'gmail',
        accounts: [account('gmail-1', 'gmail'), account('ms-1', 'microsoft')]
      })
    )

    await invoke(IpcChannel.Email.openWebmail, 'ms-1')

    expect(openExternal).toHaveBeenCalledWith('https://outlook.live.com/mail/')
  })

  it('falls back to the primary account when none is named', async () => {
    getStatus.mockReturnValue(status({ provider: 'gmail' }))

    await invoke(IpcChannel.Email.openWebmail)

    expect(openExternal).toHaveBeenCalledWith('https://mail.google.com/')
  })

  // An IMAP primary used to refuse for every account, naming a provider the
  // reader was not looking at.
  it('opens a webmail account even when the primary is IMAP', async () => {
    getStatus.mockReturnValue(
      status({
        provider: 'imap',
        accounts: [account('imap-1', 'imap'), account('gmail-2', 'gmail')]
      })
    )

    await invoke(IpcChannel.Email.openWebmail, 'gmail-2')

    expect(openExternal).toHaveBeenCalledWith('https://mail.google.com/')
  })

  it('refuses an account with no web interface, naming its own provider', async () => {
    getStatus.mockReturnValue(status({ provider: 'gmail', accounts: [account('imap-1', 'imap')] }))

    const result = (await invoke(IpcChannel.Email.openWebmail, 'imap-1')) as {
      ok: boolean
      error: { detail: string }
    }

    expect(result.ok).toBe(false)
    expect(result.error.detail).toContain('imap')
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('reports a failure to open the browser rather than throwing', async () => {
    getStatus.mockReturnValue(status())
    openExternal.mockRejectedValue(new Error('no handler'))

    const result = (await invoke(IpcChannel.Email.openWebmail)) as { ok: boolean }

    expect(result.ok).toBe(false)
  })
})

describe('saveAttachment', () => {
  beforeEach(() => {
    getAttachment.mockResolvedValue({ data: Buffer.from('bytes'), filename: 'report.pdf' })
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/chosen/report.pdf' })
  })

  function save(filename: string): Promise<unknown> {
    return invoke(IpcChannel.Email.saveAttachment, {
      messageId: 'm1',
      attachmentId: 'a1',
      filename
    })
  }

  it('suggests the attachment name as sent', async () => {
    await save('report.pdf')

    expect(showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: 'report.pdf' })
    )
  })

  /**
   * The name is chosen by whoever sent the mail and was handed to `defaultPath`
   * whole, so an attachment could open the dialog pointed at a path the reader
   * never navigated to. They still press Save — but the dialog is meant to be
   * where *they* choose the destination.
   */
  it('reduces a traversal name to its last segment', async () => {
    await save('../../../.bashrc')

    expect(showSaveDialog).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: '.bashrc' }))
  })

  it('reduces a Windows path, whose separator POSIX basename ignores', async () => {
    await save('..\\..\\AppData\\Roaming\\Anodex\\settings.json')

    expect(showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: 'settings.json' })
    )
  })

  it('falls back for a name that reduces to nothing usable', async () => {
    await save('../')

    expect(showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: 'attachment' })
    )
  })

  it('fetches nothing when the dialog is cancelled', async () => {
    showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined })

    const result = (await save('report.pdf')) as { ok: boolean; value: { path: string | null } }

    expect(result.value.path).toBeNull()
    // Cancelling must not cost a mailbox round trip.
    expect(getAttachment).not.toHaveBeenCalled()
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('reports a failed write instead of throwing across the bridge', async () => {
    writeFile.mockRejectedValue(new Error('disk full'))

    const result = (await save('report.pdf')) as { ok: boolean; error: { detail: string } }

    expect(result.ok).toBe(false)
    expect(result.error.detail).toContain('disk full')
  })
})

describe('registration', () => {
  it('answers every channel the bridge declares for mail', () => {
    // A channel the preload exposes with no handler behind it is a rejection
    // the renderer sees as an unexplained failure.
    for (const channel of Object.values(IpcChannel.Email)) {
      expect(handlers.has(channel)).toBe(true)
    }
  })
})
