import { randomUUID } from 'node:crypto'
import type {
  EmailAttachmentSummary,
  EmailConnectionStatus,
  EmailDraft,
  EmailDraftRequest,
  EmailListThreadsRequest,
  EmailMessage,
  EmailSearchRequest,
  EmailSendRequest,
  EmailThreadSummary
} from '@shared/email.types'
import { settingsStore } from '../settings/SettingsStore'
import { emailAuthStore } from './EmailAuthStore'
import { runLoopbackAuthorization } from '../oauth/loopbackServer'

const MAX_EMAIL_RESULTS = 20
const AUTH_TIMEOUT_MS = 120_000
const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.send'
]

interface GmailToken {
  accessToken: string
  refreshToken?: string
  expiresAt: number
  scope: string
  tokenType: string
}

interface GoogleTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  scope?: string
  token_type?: string
}

interface GmailMessageListResponse {
  messages?: { id: string; threadId: string }[]
}

interface GmailProfileResponse {
  emailAddress?: string
}

interface GmailThreadResponse {
  id: string
  messages?: GmailApiMessage[]
}

interface GmailAttachmentResponse {
  data?: string
  size?: number
}

interface EmailAttachmentContent extends EmailAttachmentSummary {
  data: Buffer
}

interface GmailApiMessage {
  id: string
  threadId: string
  labelIds?: string[]
  snippet?: string
  internalDate?: string
  payload?: GmailPayload
}

interface GmailPayload {
  mimeType?: string
  filename?: string
  body?: {
    data?: string
    attachmentId?: string
    size?: number
  }
  headers?: GmailHeader[]
  parts?: GmailPayload[]
}

interface GmailHeader {
  name: string
  value: string
}

class EmailService {
  private drafts = new Map<string, EmailDraft>()

  getStatus(): EmailConnectionStatus {
    const { email } = settingsStore.get()
    const gmail = email.gmail
    const enabled = email.provider === 'gmail' && gmail.enabled
    const connected = enabled && emailAuthStore.hasToken('gmail')

    return {
      provider: 'gmail',
      enabled,
      connected,
      address: gmail.address,
      syncMode: gmail.syncMode,
      sendRequiresApproval: gmail.sendRequiresApproval,
      reason: this.statusReason(enabled, connected)
    }
  }

  async connectGmail(): Promise<EmailConnectionStatus> {
    const { email } = settingsStore.get()
    const gmail = email.gmail
    if (email.provider !== 'gmail' || !gmail.enabled) {
      throw new Error('Enable Gmail before connecting.')
    }

    const clientId = gmail.oauthClientId.trim()
    if (!clientId) {
      throw new Error('Add a Google OAuth desktop app Client ID in Settings -> Email.')
    }

    const { code, redirectUri } = await waitForOAuthCode(clientId)
    const token = await exchangeCodeForToken(code, redirectUri)
    emailAuthStore.setToken('gmail', token)

    const profile = await this.getProfile().catch(() => null)
    if (profile?.emailAddress && profile.emailAddress !== gmail.address) {
      settingsStore.update({ email: { gmail: { address: profile.emailAddress } } })
    }

    return this.getStatus()
  }

  disconnectGmail(): EmailConnectionStatus {
    emailAuthStore.clearToken('gmail')
    return this.getStatus()
  }

  async listThreads(request: EmailListThreadsRequest = {}): Promise<EmailThreadSummary[]> {
    this.requireConnected()
    return this.fetchThreadSummaries({ limit: request.limit, inboxOnly: true })
  }

  async search(request: EmailSearchRequest): Promise<EmailThreadSummary[]> {
    this.requireConnected()
    const query = request.query.trim()
    if (!query) throw new Error('query is required.')
    return this.fetchThreadSummaries({ limit: request.limit, query })
  }

  async readMessage(id: string): Promise<EmailMessage> {
    this.requireConnected()
    const messageId = id.trim()
    if (!messageId) throw new Error('message id is required.')
    const message = await this.gmailFetch<GmailApiMessage>(
      `/messages/${encodeURIComponent(messageId)}?format=full`
    )
    return toEmailMessage(message)
  }

  async summarizeThread(threadId: string): Promise<string> {
    this.requireConnected()
    const id = threadId.trim()
    if (!id) throw new Error('thread id is required.')
    const thread = await this.gmailFetch<GmailThreadResponse>(
      `/threads/${encodeURIComponent(id)}?format=full`
    )
    const messages = thread.messages ?? []
    if (messages.length === 0) return 'No messages found in this thread.'
    const subject = header(messages[0], 'Subject') || '(no subject)'
    const participants = Array.from(
      new Set(messages.flatMap((message) => [header(message, 'From'), header(message, 'To')]))
    )
      .filter(Boolean)
      .slice(0, 8)
      .join('; ')
    const latest = messages[messages.length - 1]
    return [
      `Subject: ${subject}`,
      `Messages: ${messages.length}`,
      participants ? `Participants: ${participants}` : null,
      `Latest: ${new Date(Number(latest.internalDate ?? Date.now())).toLocaleString()}`,
      '',
      ...messages.slice(-5).map((message, index) => {
        const from = header(message, 'From') || 'Unknown sender'
        return `${index + 1}. ${from}: ${message.snippet ?? truncate(extractBody(message.payload), 180)}`
      })
    ]
      .filter(Boolean)
      .join('\n')
  }

  async listAttachments(threadId: string): Promise<EmailAttachmentSummary[]> {
    this.requireConnected()
    const id = threadId.trim()
    if (!id) throw new Error('thread id is required.')
    const thread = await this.gmailFetch<GmailThreadResponse>(
      `/threads/${encodeURIComponent(id)}?format=full`
    )
    return (thread.messages ?? []).flatMap((message) => extractAttachments(message.payload))
  }

  async getAttachment(messageId: string, attachmentId: string): Promise<EmailAttachmentContent> {
    this.requireConnected()
    const id = messageId.trim()
    const attachment = attachmentId.trim()
    if (!id) throw new Error('message id is required.')
    if (!attachment) throw new Error('attachment id is required.')

    const message = await this.gmailFetch<GmailApiMessage>(
      `/messages/${encodeURIComponent(id)}?format=full`
    )
    const metadata = extractAttachments(message.payload).find((item) => item.id === attachment)
    if (!metadata) throw new Error('Attachment was not found on that message.')

    const response = await this.gmailFetch<GmailAttachmentResponse>(
      `/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachment)}`
    )
    if (!response.data) throw new Error('Attachment response did not include data.')
    return {
      ...metadata,
      size: response.size ?? metadata.size,
      data: decodeBase64UrlBuffer(response.data)
    }
  }

  createDraft(request: EmailDraftRequest): EmailDraft {
    validateDraftRequest(request)
    const draft: EmailDraft = {
      id: randomUUID(),
      provider: 'gmail',
      to: request.to.map((value) => value.trim()).filter(Boolean),
      cc: request.cc?.map((value) => value.trim()).filter(Boolean) ?? [],
      bcc: request.bcc?.map((value) => value.trim()).filter(Boolean) ?? [],
      subject: request.subject.trim(),
      body: request.body.trim(),
      createdAt: Date.now()
    }
    this.drafts.set(draft.id, draft)
    return draft
  }

  async send(request: EmailSendRequest): Promise<void> {
    this.requireConnected()
    validateDraftRequest(request)
    await this.gmailFetch('/messages/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: encodeBase64Url(buildMimeMessage(request)) })
    })
  }

  private async fetchThreadSummaries(options: {
    limit?: number
    query?: string
    inboxOnly?: boolean
  }): Promise<EmailThreadSummary[]> {
    const limit = normalizeLimit(options.limit)
    const params = new URLSearchParams({ maxResults: String(limit) })
    if (options.query) params.set('q', options.query)
    if (options.inboxOnly) params.append('labelIds', 'INBOX')
    const result = await this.gmailFetch<GmailMessageListResponse>(`/messages?${params.toString()}`)
    const messages = result.messages ?? []
    const seenThreads = new Set<string>()
    const summaries: EmailThreadSummary[] = []

    for (const listed of messages) {
      if (seenThreads.has(listed.threadId)) continue
      seenThreads.add(listed.threadId)
      const message = await this.gmailFetch<GmailApiMessage>(
        `/messages/${encodeURIComponent(listed.id)}?format=metadata`
      )
      summaries.push(toThreadSummary(message))
      if (summaries.length >= limit) break
    }

    return summaries
  }

  private async getProfile(): Promise<GmailProfileResponse> {
    return this.gmailFetch<GmailProfileResponse>('/profile')
  }

  private async gmailFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.getAccessToken()
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${token}`)
    const response = await fetch(`${GMAIL_API_BASE}${path}`, {
      ...init,
      headers
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => response.statusText)
      throw new Error(`Gmail API ${response.status}: ${detail}`)
    }
    return (await response.json()) as T
  }

  private async getAccessToken(): Promise<string> {
    const token = emailAuthStore.getToken<GmailToken>('gmail')
    if (!token) throw new Error('Gmail is not connected.')
    if (token.expiresAt > Date.now() + 60_000) return token.accessToken
    if (!token.refreshToken)
      throw new Error('Gmail token expired and no refresh token is available.')

    const refreshed = await refreshToken(token.refreshToken)
    const next: GmailToken = {
      ...token,
      accessToken: refreshed.accessToken,
      expiresAt: refreshed.expiresAt,
      scope: refreshed.scope || token.scope,
      tokenType: refreshed.tokenType || token.tokenType
    }
    emailAuthStore.setToken('gmail', next)
    return next.accessToken
  }

  private requireConnected(): void {
    const status = this.getStatus()
    if (!status.enabled) {
      throw new Error('Gmail is disabled. Enable it in Settings -> Email.')
    }
    if (!status.connected) {
      throw new Error(status.reason ?? 'Gmail is not connected.')
    }
  }

  private statusReason(enabled: boolean, connected: boolean): string | undefined {
    const gmail = settingsStore.get().email.gmail
    if (!enabled) return 'Gmail is disabled.'
    if (!gmail.oauthClientId.trim()) return 'Add a Google OAuth desktop app Client ID.'
    if (!connected) return 'Click Connect to authorize Gmail.'
    return undefined
  }
}

async function waitForOAuthCode(clientId: string): Promise<{ code: string; redirectUri: string }> {
  const state = randomUUID()
  const { params, redirectUri } = await runLoopbackAuthorization({
    expectedState: state,
    timeoutMs: AUTH_TIMEOUT_MS,
    buildAuthorizationUrl: (redirectUri) => {
      const authParams = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: GMAIL_SCOPES.join(' '),
        access_type: 'offline',
        prompt: 'consent',
        state
      })
      return `${GOOGLE_AUTH_URL}?${authParams.toString()}`
    }
  })
  const code = params.get('code')
  if (!code) throw new Error('Gmail authorization response was missing a code.')
  return { code, redirectUri }
}

async function exchangeCodeForToken(code: string, redirectUri: string): Promise<GmailToken> {
  const { email } = settingsStore.get()
  const params = new URLSearchParams({
    client_id: email.gmail.oauthClientId.trim(),
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri
  })
  const clientSecret = email.gmail.oauthClientSecret.trim()
  if (clientSecret) params.set('client_secret', clientSecret)
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  })
  if (!response.ok) {
    throw new Error(`Google token exchange failed: ${await response.text()}`)
  }
  return toGmailToken((await response.json()) as GoogleTokenResponse)
}

async function refreshToken(refreshTokenValue: string): Promise<GmailToken> {
  const { email } = settingsStore.get()
  const params = new URLSearchParams({
    client_id: email.gmail.oauthClientId.trim(),
    refresh_token: refreshTokenValue,
    grant_type: 'refresh_token'
  })
  const clientSecret = email.gmail.oauthClientSecret.trim()
  if (clientSecret) params.set('client_secret', clientSecret)
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  })
  if (!response.ok) {
    throw new Error(`Google token refresh failed: ${await response.text()}`)
  }
  return {
    ...toGmailToken((await response.json()) as GoogleTokenResponse),
    refreshToken: refreshTokenValue
  }
}

function toGmailToken(response: GoogleTokenResponse): GmailToken {
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresAt: Date.now() + Math.max(0, response.expires_in - 30) * 1000,
    scope: response.scope ?? GMAIL_SCOPES.join(' '),
    tokenType: response.token_type ?? 'Bearer'
  }
}

function toThreadSummary(message: GmailApiMessage): EmailThreadSummary {
  return {
    id: message.threadId,
    provider: 'gmail',
    subject: header(message, 'Subject') || '(no subject)',
    from: header(message, 'From') || 'Unknown sender',
    snippet: message.snippet ?? '',
    updatedAt: Number(message.internalDate ?? Date.now()),
    unread: Boolean(message.labelIds?.includes('UNREAD')),
    messageCount: 1,
    attachmentCount: extractAttachments(message.payload).length
  }
}

function toEmailMessage(message: GmailApiMessage): EmailMessage {
  return {
    id: message.id,
    threadId: message.threadId,
    provider: 'gmail',
    subject: header(message, 'Subject') || '(no subject)',
    from: header(message, 'From') || 'Unknown sender',
    to: splitAddresses(header(message, 'To')),
    cc: splitAddresses(header(message, 'Cc')),
    bcc: splitAddresses(header(message, 'Bcc')),
    date: Number(message.internalDate ?? Date.now()),
    snippet: message.snippet ?? '',
    body: extractBody(message.payload),
    attachments: extractAttachments(message.payload)
  }
}

function header(message: GmailApiMessage, name: string): string {
  return (
    message.payload?.headers?.find((item) => item.name.toLowerCase() === name.toLowerCase())
      ?.value ?? ''
  )
}

function splitAddresses(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

function extractBody(payload: GmailPayload | undefined): string {
  if (!payload) return ''
  if (payload.mimeType === 'text/plain' && payload.body?.data)
    return decodeBase64Url(payload.body.data)
  if (payload.parts) {
    const plain = payload.parts.map(extractBody).find((part) => part.trim())
    if (plain) return plain
  }
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return decodeBase64Url(payload.body.data)
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }
  return ''
}

function extractAttachments(payload: GmailPayload | undefined): EmailAttachmentSummary[] {
  if (!payload) return []
  const current =
    payload.filename && payload.body?.attachmentId
      ? [
          {
            id: payload.body.attachmentId,
            filename: payload.filename,
            mimeType: payload.mimeType ?? 'application/octet-stream',
            size: payload.body.size ?? 0
          }
        ]
      : []
  return [...current, ...(payload.parts?.flatMap(extractAttachments) ?? [])]
}

function buildMimeMessage(request: EmailSendRequest): string {
  const headers = [
    `To: ${request.to.join(', ')}`,
    request.cc?.length ? `Cc: ${request.cc.join(', ')}` : null,
    request.bcc?.length ? `Bcc: ${request.bcc.join(', ')}` : null,
    `Subject: ${request.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    request.body
  ]
  return headers.filter((line) => line !== null).join('\r\n')
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 10
  if (!Number.isFinite(limit)) throw new Error('limit must be a finite number.')
  return Math.max(1, Math.min(Math.floor(limit), MAX_EMAIL_RESULTS))
}

function validateDraftRequest(request: EmailDraftRequest): void {
  const to = request.to.map((value) => value.trim()).filter(Boolean)
  if (to.length === 0) throw new Error('At least one recipient is required.')
  if (!request.subject.trim()) throw new Error('subject is required.')
  if (!request.body.trim()) throw new Error('body is required.')
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function decodeBase64Url(value: string): string {
  return decodeBase64UrlBuffer(value).toString('utf-8')
}

function decodeBase64UrlBuffer(value: string): Buffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(normalized, 'base64')
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text
}

export const emailService = new EmailService()
