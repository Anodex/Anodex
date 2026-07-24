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
  readEmailTool,
  saveEmailAttachmentTool,
  sendEmailTool
} from '../emailTools'
import { checkpointStore } from '../../checkpoints/CheckpointStore'
import { captureConfirmations, createMockContext, createMockDefine } from './test-helpers'

const createDraftMock = vi.fn<(request: EmailDraftRequest) => EmailDraft>()
const sendMock = vi.fn<(request: EmailSendRequest) => void>()
const getDraftMock = vi.fn<(draftId: string) => EmailDraft | undefined>()
const getAttachmentMock =
  vi.fn<() => Promise<{ filename: string; mimeType: string; data: Buffer }>>()
const readMessageMock = vi.fn<(id: string) => Promise<EmailMessage>>()
const listAttachmentsMock = vi.fn<(id: string) => Promise<EmailAttachmentSummary[]>>()

vi.mock('../../email/EmailService', () => ({
  emailService: {
    createDraft: (request: EmailDraftRequest) => createDraftMock(request),
    send: (request: EmailSendRequest) => sendMock(request),
    getDraft: (draftId: string) => getDraftMock(draftId),
    getAttachment: () => getAttachmentMock(),
    readMessage: (id: string) => readMessageMock(id),
    listAttachments: (id: string) => listAttachmentsMock(id)
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
    createDraftMock.mockImplementation((request) => ({
      id: 'draft-1',
      provider: 'gmail',
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
