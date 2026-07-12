import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailDraft, EmailDraftRequest, EmailSendRequest } from '@shared/email.types'
import { draftEmailTool, saveEmailAttachmentTool, sendEmailTool } from '../emailTools'
import { captureConfirmations, createMockContext, createMockDefine } from './test-helpers'

const createDraftMock = vi.fn<(request: EmailDraftRequest) => EmailDraft>()
const sendMock = vi.fn<(request: EmailSendRequest) => void>()
const getAttachmentMock = vi.fn<() => Promise<{ filename: string; mimeType: string; data: Buffer }>>()

vi.mock('../../email/EmailService', () => ({
  emailService: {
    createDraft: (request: EmailDraftRequest) => createDraftMock(request),
    send: (request: EmailSendRequest) => sendMock(request),
    getAttachment: () => getAttachmentMock()
  }
}))

describe('email tools', () => {
  beforeEach(() => {
    createDraftMock.mockReset()
    sendMock.mockReset()
    getAttachmentMock.mockReset()
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
    const ctx = { ...createMockContext('/workspace'), permissionMode: 'untethered' as const, confirm }
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

  it('saves an email attachment into the workspace with approval', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'anodex-email-attachment-'))
    try {
      getAttachmentMock.mockResolvedValue({
        filename: 'report.pdf',
        mimeType: 'application/pdf',
        data: Buffer.from('pdf bytes')
      })
      const { requests, confirm } = captureConfirmations()
      const ctx = { ...createMockContext(workspace), projectId: 'project-1', confirm }
      const tool = saveEmailAttachmentTool(createMockDefine(), ctx) as unknown as {
        handler: (args: unknown) => Promise<string>
      }

      const result = await tool.handler({
        messageId: 'message-1',
        attachmentId: 'attachment-1',
        path: 'downloads/report.pdf'
      })

      expect(result).toContain('Saved attachment report.pdf')
      expect(await readFile(join(workspace, 'downloads', 'report.pdf'), 'utf-8')).toBe('pdf bytes')
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({ toolName: 'save_email_attachment', kind: 'write' })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
