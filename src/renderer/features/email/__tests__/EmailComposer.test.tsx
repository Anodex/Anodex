// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '../../../test-utils/dom'
import { EmailComposer } from '../EmailComposer'
import { blankDraft, replyDraft } from '../composeMail'
import type { MailDraft } from '../composeMail'
import type { EmailMessage } from '@shared/email.types'

/**
 * The window this app did not have.
 *
 * Every message that ever left Anodex on the desktop was written by the model
 * through `send_email` — there was no Write button, no reply box, no way to
 * send three words without asking for them. The phone could do it. This is
 * that, and these assertions are about the two things that are easy to get
 * wrong in a compose window and expensive afterwards.
 */

const state = vi.hoisted(() => ({
  composing: null as MailDraft | null,
  sending: false,
  writing: false
}))

vi.mock('../../../stores/emailStore', () => ({
  useEmailStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      composing: state.composing,
      sending: state.sending,
      writing: state.writing,
      updateCompose: vi.fn(),
      closeCompose: vi.fn(),
      sendCompose: vi.fn(),
      writeBody: vi.fn()
    })
}))

function message(): EmailMessage {
  return {
    id: 'm1',
    threadId: 't1',
    provider: 'imap',
    accountId: 'a1',
    subject: 'Quarterly report',
    from: 'Ada <ada@example.com>',
    to: ['me@example.com'],
    cc: [],
    bcc: [],
    date: 0,
    snippet: '',
    body: 'The numbers are attached.',
    attachments: []
  }
}

describe('EmailComposer', () => {
  it('is not there when nothing is being written', () => {
    state.composing = null

    const { container } = render(<EmailComposer />)

    expect(container.innerHTML).toBe('')
    expect(document.body.textContent).toBe('')
  })

  it('refuses to send an unfinished message, and says what is missing', () => {
    // Each missing field fails differently — no recipient cannot be sent, no
    // subject arrives looking like spam, an empty body is a message somebody
    // sent by accident — and a Send button that is simply dead tells you none
    // of that.
    state.composing = blankDraft('a1')
    render(<EmailComposer />)

    expect(screen.getByText('Needs a recipient, a subject and something to say.')).toBeTruthy()
    expect(screen.getByRole('button', { name: /send/i }).hasAttribute('disabled')).toBe(true)
  })

  it('offers the model inside the window rather than instead of it', () => {
    // The whole point of the change. The body field is yours; "Have Anodex
    // write it" is one control within it, not the only door out of the app.
    state.composing = replyDraft(message(), false)
    render(<EmailComposer />)

    expect(screen.getByText('Have Anodex write it')).toBeTruthy()
    expect(screen.getByPlaceholderText('Write your message')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Reply' })).toBeTruthy()
  })

  it('offers to rewrite once there is something to rewrite', () => {
    state.composing = { ...blankDraft(), body: 'Already written.' }
    render(<EmailComposer />)

    expect(screen.getByText('Have Anodex rewrite it')).toBeTruthy()
  })

  it('a ready message can be sent, and says where it goes from', () => {
    state.composing = {
      ...blankDraft('a1'),
      to: 'ada@example.com',
      subject: 'Yes',
      body: 'Tuesday works.'
    }
    render(<EmailComposer />)

    expect(
      screen.getByText('Sent from this computer, using the account connected here.')
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: /send/i }).hasAttribute('disabled')).toBe(false)
  })
})
