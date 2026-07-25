import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  EmailAttachmentSummary,
  EmailDraft,
  EmailDraftRequest,
  EmailMessage,
  EmailSendRequest
} from '@shared/email.types'
import {
  draftEmailTool,
  findEmailAttachmentsTool,
  manageEmailTool,
  readEmailTool,
  replyEmailTool,
  saveEmailAttachmentTool,
  sendEmailTool
} from '../emailTools'
import { checkpointStore } from '../../checkpoints/CheckpointStore'
import { headlessConfirm } from '../headlessConfirm'
import { captureConfirmations, createMockContext, createMockDefine } from './test-helpers'

const createDraftMock = vi.fn<(request: EmailDraftRequest) => EmailDraft>()
const sendMock = vi.fn<(request: EmailSendRequest) => void>()
const getDraftMock = vi.fn<(draftId: string) => EmailDraft | undefined>()
const getAttachmentMock =
  vi.fn<() => Promise<{ filename: string; mimeType: string; data: Buffer }>>()
const readMessageMock = vi.fn<(id: string) => Promise<EmailMessage>>()
const listAttachmentsMock = vi.fn<(id: string) => Promise<EmailAttachmentSummary[]>>()
const prepareReplyMock = vi.fn<(request: unknown) => Promise<unknown>>()
const sendPreparedMock = vi.fn<(prepared: unknown) => void>()
const applyFlagMock = vi.fn<(request: unknown) => Promise<string>>()

vi.mock('../../email/EmailService', () => ({
  emailService: {
    createDraft: (request: EmailDraftRequest) => createDraftMock(request),
    send: (request: EmailSendRequest) => sendMock(request),
    getDraft: (draftId: string) => getDraftMock(draftId),
    getAttachment: () => getAttachmentMock(),
    readMessage: (id: string) => readMessageMock(id),
    listAttachments: (id: string) => listAttachmentsMock(id),
    prepareReply: (request: unknown) => prepareReplyMock(request),
    sendPrepared: (prepared: unknown) => sendPreparedMock(prepared),
    applyFlag: (request: unknown) => applyFlagMock(request)
  }
}))

describe('email tools', () => {
  beforeEach(() => {
    createDraftMock.mockReset()
    sendMock.mockReset()
    getDraftMock.mockReset()
    getAttachmentMock.mockReset()
    readMessageMock.mockReset()
    listAttachmentsMock.mockReset()
    prepareReplyMock.mockReset()
    sendPreparedMock.mockReset()
    applyFlagMock.mockReset()
    createDraftMock.mockImplementation((request) => ({
      id: 'draft-1',
      provider: 'gmail',
      accountId: 'account-1',
      to: request.to,
      cc: request.cc ?? [],
      bcc: request.bcc ?? [],
      subject: request.subject,
      body: request.body,
      createdAt: 0
    }))
  })

  it('returns the identifiers needed to save a message attachment', async () => {
    const attachment = {
      id: 'attachment-1',
      messageId: 'message-1',
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      size: 42
    }
    readMessageMock.mockResolvedValue({
      id: 'message-1',
      threadId: 'thread-1',
      provider: 'gmail',
      accountId: 'account-1',
      subject: 'Report',
      from: 'sender@example.com',
      to: ['user@example.com'],
      cc: [],
      bcc: [],
      date: 0,
      snippet: '',
      body: 'Attached.',
      attachments: [attachment]
    })
    listAttachmentsMock.mockResolvedValue([attachment])
    const ctx = createMockContext('/workspace')
    const readTool = readEmailTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { messageId: string }) => Promise<string>
    }
    const findTool = findEmailAttachmentsTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { threadId: string }) => Promise<string>
    }

    expect(await readTool.handler({ messageId: 'message-1' })).toContain(
      'messageId: message-1; attachmentId: attachment-1'
    )
    expect(await findTool.handler({ threadId: 'thread-1' })).toContain(
      'messageId: message-1; attachmentId: attachment-1'
    )
  })

  it('creates a local draft without asking for approval', async () => {
    const { requests, confirm } = captureConfirmations()
    const ctx = { ...createMockContext('/workspace'), confirm }
    const tool = draftEmailTool(createMockDefine(), ctx) as unknown as {
      handler: (args: EmailDraftRequest) => Promise<string>
    }

    const result = await tool.handler({
      to: ['person@example.com'],
      subject: 'Hello',
      body: 'Draft body'
    })

    expect(result).toContain('Draft id: draft-1')
    expect(requests).toHaveLength(0)
    expect(createDraftMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: ['person@example.com'], subject: 'Hello' })
    )
  })

  it('always asks before sending, even in untethered mode', async () => {
    const { requests, confirm } = captureConfirmations()
    const ctx = {
      ...createMockContext('/workspace'),
      permissionMode: 'untethered' as const,
      confirm
    }
    const tool = sendEmailTool(createMockDefine(), ctx) as unknown as {
      handler: (args: EmailSendRequest) => Promise<string>
    }

    const result = await tool.handler({
      to: ['person@example.com'],
      subject: 'Hello',
      body: 'Send body'
    })

    expect(result).toBe('Email sent.')
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      toolName: 'send_email',
      kind: 'write',
      risk: 'sensitive'
    })
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: ['person@example.com'], subject: 'Hello' })
    )
    // The flag has to reach the confirm request, or the headless handlers the
    // unattended surfaces install cannot tell this apart from any other
    // sensitive write and will approve it.
    expect(requests[0].requiresHumanApproval).toBe(true)
  })

  it('cannot send in an unattended run', async () => {
    // The real policy scheduled tasks and agent runs install, exercised through
    // the tool rather than in isolation: `EmailSettings.sendRequiresApproval` is
    // the literal `true`, so this is the test that keeps that claim honest.
    const ctx = {
      ...createMockContext('/workspace'),
      permissionMode: 'untethered' as const,
      confirm: headlessConfirm
    }
    const tool = sendEmailTool(createMockDefine(), ctx) as unknown as {
      handler: (args: EmailSendRequest) => Promise<string>
    }

    const result = await tool.handler({
      to: ['person@example.com'],
      subject: 'Hello',
      body: 'Send body'
    })

    expect(sendMock).not.toHaveBeenCalled()
    expect(result).toContain('draft_email')
  })

  it('cannot reply in an unattended run', async () => {
    prepareReplyMock.mockResolvedValue({
      parentSubject: 'Urgent response',
      message: {
        to: ['person@example.com'],
        subject: 'Re: Urgent response',
        body: 'Reply body'
      }
    })
    const ctx = {
      ...createMockContext('/workspace'),
      permissionMode: 'untethered' as const,
      confirm: headlessConfirm
    }
    const tool = replyEmailTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { messageId: string; body: string }) => Promise<string>
    }

    const result = await tool.handler({ messageId: 'msg-1', body: 'Reply body' })

    expect(sendPreparedMock).not.toHaveBeenCalled()
    expect(result).toContain('draft_email')
  })

  it('still lets an unattended run save a draft for the user to send', async () => {
    // The other half of the contract: refusing to send must not also block the
    // "prepare it and tell me" path a scheduled task is supposed to take.
    const ctx = {
      ...createMockContext('/workspace'),
      permissionMode: 'untethered' as const,
      confirm: headlessConfirm
    }
    const tool = draftEmailTool(createMockDefine(), ctx) as unknown as {
      handler: (args: EmailDraftRequest) => Promise<string>
    }

    const result = await tool.handler({
      to: ['person@example.com'],
      subject: 'Hello',
      body: 'Draft body'
    })

    expect(result).toContain('Draft id:')
  })

  it('does not send when the user denies approval', async () => {
    const ctx = {
      ...createMockContext('/workspace'),
      confirm: () => Promise.resolve({ approved: false, reason: 'not this one' })
    }
    const tool = sendEmailTool(createMockDefine(), ctx) as unknown as {
      handler: (args: EmailSendRequest) => Promise<string>
    }

    const result = await tool.handler({
      to: ['person@example.com'],
      subject: 'Hello',
      body: 'Send body'
    })

    expect(result).toContain('not this one')
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('confirms against the saved draft, not the placeholder args, when sending by draftId', async () => {
    getDraftMock.mockReturnValue({
      id: 'draft-1',
      provider: 'gmail',
      accountId: 'account-1',
      to: ['real-recipient@example.com'],
      cc: [],
      bcc: [],
      subject: 'Real subject',
      body: 'Real body',
      createdAt: 0
    })
    const { requests, confirm } = captureConfirmations()
    const ctx = { ...createMockContext('/workspace'), confirm }
    const tool = sendEmailTool(createMockDefine(), ctx) as unknown as {
      handler: (args: EmailSendRequest) => Promise<string>
    }

    // The model must still fill required to/subject/body even when sending
    // a draft — this call deliberately sends stale/placeholder values that
    // differ from the saved draft, to prove the approval prompt (and the
    // reported result) reflect the draft that actually gets sent, not these.
    const result = await tool.handler({
      draftId: 'draft-1',
      to: ['placeholder@example.com'],
      subject: 'Placeholder subject',
      body: 'Placeholder body'
    })

    expect(result).toBe('Email sent.')
    expect(requests).toHaveLength(1)
    expect(requests[0].detail).toContain('real-recipient@example.com')
    expect(requests[0].detail).toContain('Real subject')
    expect(requests[0].detail).toContain('Real body')
    expect(requests[0].detail).not.toContain('placeholder@example.com')
    expect(requests[0].detail).not.toContain('Placeholder subject')
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ draftId: 'draft-1' }))
  })

  it('fails cleanly with no confirm prompt when the referenced draft no longer exists', async () => {
    getDraftMock.mockReturnValue(undefined)
    const { requests, confirm } = captureConfirmations()
    const ctx = { ...createMockContext('/workspace'), confirm }
    const tool = sendEmailTool(createMockDefine(), ctx) as unknown as {
      handler: (args: EmailSendRequest) => Promise<string>
    }

    const result = await tool.handler({
      draftId: 'missing-draft',
      to: ['person@example.com'],
      subject: 'Hello',
      body: 'Send body'
    })

    expect(result).toContain('Email draft not found: missing-draft')
    expect(requests).toHaveLength(0)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('confirms a reply against the resolved recipients, not the model arguments', async () => {
    // The model never names the recipients on a reply — they come from the
    // parent message — so the prompt has to show what `prepareReply` resolved.
    prepareReplyMock.mockResolvedValue({
      accountId: 'account-1',
      parentSubject: 'Quarterly numbers',
      message: {
        to: ['sender@example.com'],
        cc: ['team@example.com'],
        bcc: [],
        subject: 'Re: Quarterly numbers',
        body: 'Looks good.',
        attachments: [],
        inReplyTo: '<parent@example.com>',
        references: ['<parent@example.com>'],
        threadId: 'thread-1'
      }
    })
    const { requests, confirm } = captureConfirmations()
    const ctx = {
      ...createMockContext('/workspace'),
      permissionMode: 'untethered' as const,
      confirm
    }
    const tool = replyEmailTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { messageId: string; body: string }) => Promise<string>
    }

    const result = await tool.handler({ messageId: 'message-1', body: 'Looks good.' })

    expect(result).toBe('Reply sent.')
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ toolName: 'reply_email', risk: 'sensitive' })
    expect(requests[0].detail).toContain('Replying to: Quarterly numbers')
    expect(requests[0].detail).toContain('sender@example.com')
    expect(requests[0].detail).toContain('team@example.com')
    expect(sendPreparedMock).toHaveBeenCalledTimes(1)
  })

  it('carries the whole reply as a structured draft, not a truncated preview', async () => {
    // The card renders this instead of the detail text, and approving a
    // message you were shown only the first part of is not consent — so the
    // body travels in full even though the text detail is capped.
    const body = `Hi Dana,\n\n${'Long paragraph. '.repeat(80)}\n\nThanks.`
    prepareReplyMock.mockResolvedValue({
      accountId: 'account-1',
      parentSubject: 'Quarterly numbers',
      message: {
        to: ['sender@example.com'],
        cc: ['team@example.com'],
        bcc: [],
        subject: 'Re: Quarterly numbers',
        body,
        attachments: [{ filename: 'sheet.csv', content: Buffer.from('a') }],
        inReplyTo: '<parent@example.com>',
        references: ['<parent@example.com>'],
        threadId: 'thread-1'
      }
    })
    const { requests, confirm } = captureConfirmations()
    const ctx = {
      ...createMockContext('/workspace'),
      permissionMode: 'untethered' as const,
      confirm
    }
    const tool = replyEmailTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { messageId: string; body: string }) => Promise<string>
    }

    await tool.handler({ messageId: 'message-1', body })

    expect(requests[0].emailDraft).toMatchObject({
      to: ['sender@example.com'],
      cc: ['team@example.com'],
      subject: 'Re: Quarterly numbers',
      body,
      attachmentNames: ['sheet.csv'],
      inReplyToSubject: 'Quarterly numbers'
    })
    // Empty bcc is left out rather than shown as an empty row.
    expect(requests[0].emailDraft?.bcc).toBeUndefined()
    expect(requests[0].detail.length).toBeLessThan(body.length)
  })

  it('does not send a reply when the user denies approval', async () => {
    prepareReplyMock.mockResolvedValue({
      accountId: 'account-1',
      parentSubject: 'Quarterly numbers',
      message: {
        to: ['sender@example.com'],
        cc: [],
        bcc: [],
        subject: 'Re: Quarterly numbers',
        body: 'Looks good.',
        attachments: []
      }
    })
    const ctx = {
      ...createMockContext('/workspace'),
      confirm: () => Promise.resolve({ approved: false, reason: 'not yet' })
    }
    const tool = replyEmailTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { messageId: string; body: string }) => Promise<string>
    }

    const result = await tool.handler({ messageId: 'message-1', body: 'Looks good.' })

    expect(result).toContain('not yet')
    expect(sendPreparedMock).not.toHaveBeenCalled()
  })

  it('attaches workspace files to an outgoing email and names them in the prompt', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'anodex-email-outgoing-'))
    try {
      await writeFile(join(workspace, 'notes.txt'), 'hello attachment')
      const { requests, confirm } = captureConfirmations()
      const ctx = { ...createMockContext(workspace), confirm }
      const tool = sendEmailTool(createMockDefine(), ctx) as unknown as {
        handler: (args: EmailSendRequest & { attachmentPaths?: string[] }) => Promise<string>
      }

      const result = await tool.handler({
        to: ['person@example.com'],
        subject: 'With a file',
        body: 'See attached.',
        attachmentPaths: ['notes.txt']
      })

      expect(result).toBe('Email sent.')
      expect(requests[0].detail).toContain('Attachments: notes.txt')
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          attachments: [
            {
              filename: 'notes.txt',
              mimeType: 'text/plain',
              contentBase64: Buffer.from('hello attachment').toString('base64')
            }
          ]
        })
      )
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('refuses to attach files from outside the workspace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'anodex-email-escape-'))
    try {
      const { requests, confirm } = captureConfirmations()
      const ctx = { ...createMockContext(workspace), confirm }
      const tool = sendEmailTool(createMockDefine(), ctx) as unknown as {
        handler: (args: EmailSendRequest & { attachmentPaths?: string[] }) => Promise<string>
      }

      const result = await tool.handler({
        to: ['person@example.com'],
        subject: 'Exfiltration attempt',
        body: 'See attached.',
        attachmentPaths: ['../../../etc/passwd']
      })

      // Failing during prepare means the user is never even shown a prompt for
      // a send that would have carried a file from outside the workspace.
      expect(result).toContain('Error')
      expect(requests).toHaveLength(0)
      expect(sendMock).not.toHaveBeenCalled()
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('treats mailbox state changes as reversible rather than sensitive', async () => {
    applyFlagMock.mockResolvedValue('Archived (removed from the inbox) on user@example.com.')
    const { requests, confirm } = captureConfirmations()
    const ctx = { ...createMockContext('/workspace'), confirm }
    const tool = manageEmailTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { action: string; threadId?: string }) => Promise<string>
    }

    const result = await tool.handler({ action: 'archive', threadId: 'thread-1' })

    expect(result).toContain('Archived')
    expect(requests[0]).toMatchObject({ toolName: 'manage_email', kind: 'write', risk: 'safe' })
    expect(applyFlagMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'archive', threadId: 'thread-1' })
    )
  })

  it('saves an email attachment into the workspace with approval', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'anodex-email-attachment-'))
    try {
      const original = Buffer.from([0, 10, 20, 30, 255])
      const attachment = Buffer.from([0, 80, 68, 70, 200, 100])
      await writeFile(join(workspace, 'report.pdf'), original)
      getAttachmentMock.mockResolvedValue({
        filename: 'report.pdf',
        mimeType: 'application/pdf',
        data: attachment
      })
      const { requests, confirm } = captureConfirmations()
      const ctx = { ...createMockContext(workspace), projectId: 'project-1', confirm }
      const tool = saveEmailAttachmentTool(createMockDefine(), ctx) as unknown as {
        handler: (args: unknown) => Promise<string>
      }

      const result = await tool.handler({
        messageId: 'message-1',
        attachmentId: 'attachment-1',
        path: 'report.pdf'
      })

      expect(result).toContain('Saved attachment report.pdf')
      expect(await readFile(join(workspace, 'report.pdf'))).toEqual(attachment)
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({ toolName: 'save_email_attachment', kind: 'write' })

      const preview = checkpointStore.inspect(workspace, 'test-conversation', 'test-message')
      expect(preview.files[0]).toMatchObject({
        path: 'report.pdf',
        kind: 'modified',
        binary: true,
        beforeSize: original.length,
        afterSize: attachment.length
      })
      checkpointStore.restore(workspace, 'test-conversation', 'test-message')
      expect(await readFile(join(workspace, 'report.pdf'))).toEqual(original)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
