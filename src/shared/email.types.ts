export type EmailProvider = 'gmail'

export interface EmailConnectionStatus {
  provider: EmailProvider
  enabled: boolean
  connected: boolean
  address: string
  syncMode: 'metadata' | 'full'
  sendRequiresApproval: boolean
  reason?: string
}

export interface EmailThreadSummary {
  id: string
  provider: EmailProvider
  subject: string
  from: string
  snippet: string
  updatedAt: number
  unread: boolean
  messageCount: number
  attachmentCount: number
}

export interface EmailMessage {
  id: string
  threadId: string
  provider: EmailProvider
  subject: string
  from: string
  to: string[]
  cc: string[]
  bcc: string[]
  date: number
  snippet: string
  body: string
  attachments: EmailAttachmentSummary[]
}

export interface EmailAttachmentSummary {
  id: string
  filename: string
  mimeType: string
  size: number
}

export interface EmailSearchRequest {
  query: string
  limit?: number
}

export interface EmailListThreadsRequest {
  limit?: number
}

export interface EmailDraftRequest {
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  body: string
}

export interface EmailDraft {
  id: string
  provider: EmailProvider
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  body: string
  createdAt: number
}

export interface EmailSendRequest extends EmailDraftRequest {
  draftId?: string
}

