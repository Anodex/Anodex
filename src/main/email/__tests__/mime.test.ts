import { describe, expect, it } from 'vitest'
import {
  buildMimeMessage,
  buildReferences,
  extractAddress,
  htmlToPlainText,
  parseReferences,
  replyRecipients,
  replySubject
} from '../mime'

function baseMessage(): Parameters<typeof buildMimeMessage>[0] {
  return {
    to: ['person@example.com'],
    cc: [],
    bcc: [],
    subject: 'Hello',
    body: 'Body text',
    attachments: []
  }
}

describe('buildMimeMessage', () => {
  it('base64-encodes the body so non-ASCII survives a 7-bit transport', () => {
    const raw = buildMimeMessage({ ...baseMessage(), body: 'Grüße — 日本語' })

    expect(raw).toContain('Content-Transfer-Encoding: base64')
    const body = raw.split('\r\n\r\n')[1]
    expect(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf-8')).toBe(
      'Grüße — 日本語'
    )
  })

  it('RFC 2047 encodes a non-ASCII subject and leaves an ASCII one readable', () => {
    expect(buildMimeMessage({ ...baseMessage(), subject: 'Grüße' })).toContain(
      `Subject: =?UTF-8?B?${Buffer.from('Grüße', 'utf-8').toString('base64')}?=`
    )
    expect(buildMimeMessage(baseMessage())).toContain('Subject: Hello')
  })

  it('emits threading headers only when replying', () => {
    expect(buildMimeMessage(baseMessage())).not.toContain('In-Reply-To')

    const reply = buildMimeMessage({
      ...baseMessage(),
      inReplyTo: '<parent@example.com>',
      references: ['<root@example.com>', '<parent@example.com>']
    })
    expect(reply).toContain('In-Reply-To: <parent@example.com>')
    expect(reply).toContain('References: <root@example.com> <parent@example.com>')
  })

  it('builds a multipart body when attachments are present', () => {
    const raw = buildMimeMessage({
      ...baseMessage(),
      attachments: [
        {
          filename: 'notes.txt',
          mimeType: 'text/plain',
          contentBase64: Buffer.from('attached').toString('base64')
        }
      ]
    })

    const boundary = raw.match(/boundary="([^"]+)"/)?.[1]
    expect(boundary).toBeTruthy()
    expect(raw).toContain('Content-Type: multipart/mixed')
    expect(raw).toContain('Content-Disposition: attachment; filename="notes.txt"')
    expect(raw.trimEnd().endsWith(`--${boundary}--`)).toBe(true)
  })

  it('neutralizes quotes and newlines in an attachment filename', () => {
    // A filename is attacker-controlled when the file came from an email —
    // an unescaped quote or CRLF would let it forge MIME headers.
    const raw = buildMimeMessage({
      ...baseMessage(),
      attachments: [
        { filename: 'a"b\r\nContent-Type: evil', mimeType: 'text/plain', contentBase64: '' }
      ]
    })

    // The text survives inside the quoted filename — what must not happen is
    // it starting a line, which is what would make it a forged header.
    expect(raw.split('\r\n').some((line) => line.startsWith('Content-Type: evil'))).toBe(false)
    expect(raw).toContain('filename="a_bContent-Type: evil"')
  })

  it('wraps base64 output at the 76-character MIME line limit', () => {
    const raw = buildMimeMessage({ ...baseMessage(), body: 'x'.repeat(500) })
    const bodyLines = raw.split('\r\n\r\n')[1].split('\r\n')

    expect(bodyLines.length).toBeGreaterThan(1)
    expect(Math.max(...bodyLines.map((line) => line.length))).toBeLessThanOrEqual(76)
  })
})

describe('reply helpers', () => {
  it('does not stack a second Re: on an existing reply', () => {
    expect(replySubject('Quarterly numbers')).toBe('Re: Quarterly numbers')
    expect(replySubject('Re: Quarterly numbers')).toBe('Re: Quarterly numbers')
    expect(replySubject('RE: Quarterly numbers')).toBe('RE: Quarterly numbers')
    expect(replySubject('   ')).toBe('Re: (no subject)')
  })

  it('replies only to the sender by default', () => {
    const recipients = replyRecipients({
      from: 'Sender <sender@example.com>',
      to: ['me@example.com', 'other@example.com'],
      cc: ['cc@example.com'],
      selfAddress: 'me@example.com',
      replyAll: false
    })

    expect(recipients).toEqual({ to: ['Sender <sender@example.com>'], cc: [] })
  })

  it('keeps every participant but the account itself on reply-all', () => {
    const recipients = replyRecipients({
      from: 'sender@example.com',
      to: ['me@example.com', 'other@example.com'],
      cc: ['cc@example.com', 'Me <me@example.com>'],
      selfAddress: 'me@example.com',
      replyAll: true
    })

    expect(recipients.to).toEqual(['sender@example.com', 'other@example.com'])
    expect(recipients.cc).toEqual(['cc@example.com'])
    expect([...recipients.to, ...recipients.cc]).not.toContain('me@example.com')
  })

  it('prefers Reply-To over From when the sender asked for it', () => {
    const recipients = replyRecipients({
      from: 'noreply@example.com',
      replyTo: 'support@example.com',
      to: [],
      cc: [],
      selfAddress: 'me@example.com',
      replyAll: false
    })

    expect(recipients.to).toEqual(['support@example.com'])
  })

  it('appends the parent to the References chain without duplicating it', () => {
    expect(buildReferences(['<root@example.com>'], '<parent@example.com>')).toEqual([
      '<root@example.com>',
      '<parent@example.com>'
    ])
    expect(buildReferences(['<parent@example.com>'], '<parent@example.com>')).toEqual([
      '<parent@example.com>'
    ])
    expect(buildReferences(undefined, undefined)).toEqual([])
  })

  it('parses message ids out of a raw References header', () => {
    expect(parseReferences('<a@example.com> <b@example.com>')).toEqual([
      '<a@example.com>',
      '<b@example.com>'
    ])
    expect(parseReferences(undefined)).toEqual([])
  })

  it('pulls the bare address out of a display-name header', () => {
    expect(extractAddress('Person Name <person@example.com>')).toBe('person@example.com')
    expect(extractAddress('  person@example.com ')).toBe('person@example.com')
  })
})

describe('htmlToPlainText', () => {
  it('drops scripts and styles rather than rendering their source as text', () => {
    const text = htmlToPlainText(
      '<style>.a{color:red}</style><script>alert(1)</script><p>Real content</p>'
    )

    expect(text).toBe('Real content')
  })

  it('turns block structure into line breaks and decodes entities', () => {
    expect(htmlToPlainText('<p>One</p><p>Two</p>')).toBe('One\n\nTwo')
    expect(htmlToPlainText('a<br>b')).toBe('a\nb')
    expect(htmlToPlainText('&lt;tag&gt; &amp; &quot;quoted&quot;')).toBe('<tag> & "quoted"')
  })
})
