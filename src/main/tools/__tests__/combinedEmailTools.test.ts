import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolFunction } from '../types'
import { createMockContext, createMockDefine } from './test-helpers'

interface Thread {
  id: string
  subject: string
  from: string
  updatedAt: number
}

const h = vi.hoisted(() => ({
  inbox: [] as Thread[],
  messages: new Map<
    string,
    Array<{ id: string; threadId: string; attachments: unknown[]; from?: string }>
  >()
}))

vi.mock('../../email/EmailService', () => ({
  emailService: {
    getStatus: () => ({ accounts: [{ address: 'me@example.com' }] }),
    readMessage: (id: string) => {
      for (const [threadId, list] of h.messages) {
        const message = list.find((entry) => entry.id === id)
        const thread = h.inbox.find((entry) => entry.id === threadId)
        if (message && thread) return Promise.resolve({ ...message, ...thread, id, threadId })
      }
      return Promise.reject(new Error('not a message id'))
    },
    getThreadMessages: (id: string) =>
      h.messages.has(id)
        ? Promise.resolve(
            h.messages.get(id)?.map((message) => ({
              subject: h.inbox.find((thread) => thread.id === id)?.subject ?? '',
              from: h.inbox.find((thread) => thread.id === id)?.from ?? '',
              ...message
            }))
          )
        : Promise.reject(new Error(`"${id}" is not a thread id.`)),
    search: ({ query }: { query: string }) =>
      Promise.resolve(
        h.inbox.filter((thread) =>
          `${thread.subject} ${thread.from}`.toLowerCase().includes(query.toLowerCase())
        )
      )
  }
}))

const { combinedEmailTools, pickAttachment, writeEmailAction } =
  await import('../combinedEmailTools')

/** A separate email tool that records what it was asked to do. */
function part(name: string, calls: Array<[string, unknown]>): ToolFunction {
  return {
    description: name,
    params: {},
    handler: (args: unknown) => {
      calls.push([name, args])
      return Promise.resolve(`${name} ran`)
    }
  }
}

const PART_NAMES = [
  'list_threads',
  'search_email',
  'read_email',
  'find_attachments',
  'read_email_attachment',
  'send_email',
  'reply_email',
  'forward_email',
  'save_email_draft',
  'manage_email',
  'move_email',
  'batch_email'
] as const

function setUp(): {
  tools: Record<string, ToolFunction>
  calls: Array<[string, unknown]>
} {
  const calls: Array<[string, unknown]> = []
  const parts = Object.fromEntries(PART_NAMES.map((name) => [name, part(name, calls)]))
  const tools = combinedEmailTools(createMockDefine(), createMockContext('/workspace'), parts)
  return { tools, calls }
}

beforeEach(() => {
  h.inbox = [
    { id: 'runpod-old', subject: 'Runpod Weekly', from: 'Runpod <news@runpod.io>', updatedAt: 1 },
    { id: 'runpod-new', subject: 'Runpod Weekly', from: 'Runpod <news@runpod.io>', updatedAt: 9 },
    { id: 'reddit', subject: 'Wtf.', from: 'Reddit <noreply@redditmail.com>', updatedAt: 5 },
    {
      id: 'sinister',
      subject: 'Re: Anodex test',
      from: 'Sinistercraftnetwork <sinistercraftnetwork@gmail.com>',
      updatedAt: 7
    }
  ]
  h.messages = new Map([
    ['runpod-new', [{ id: 'runpod-new-m1', threadId: 'runpod-new', attachments: [] }]],
    ['runpod-old', [{ id: 'runpod-old-m1', threadId: 'runpod-old', attachments: [] }]],
    ['reddit', [{ id: 'reddit-m1', threadId: 'reddit', attachments: [] }]],
    [
      'sinister',
      [
        { id: 'sinister-m1', threadId: 'sinister', attachments: [] },
        { id: 'sinister-m2', threadId: 'sinister', attachments: [] }
      ]
    ]
  ])
})

describe('write_email', () => {
  it('picks what to do from what it was given, never a draft unasked', () => {
    // Llama 3.1 8B saved drafts for "Reply to …" and "Send an email to …".
    expect(writeEmailAction({ to: 'a@b.c', subject: 's', body: 'b' })).toBe('send')
    expect(writeEmailAction({ email: 'the Runpod email', body: 'thanks' })).toBe('reply')
    expect(writeEmailAction({ email: 'the Runpod email', to: ['a@b.c'] })).toBe('forward')
    expect(writeEmailAction({ action: 'draft', to: 'a@b.c' })).toBe('draft')
  })

  it('forwards "the latest Runpod email" without asking for its id', async () => {
    // Measured: "You need to get the ID of the latest Runpod email first."
    const { tools, calls } = setUp()

    await tools.write_email.handler({
      email: 'the latest Runpod email',
      to: 'sinistercraftnetwork@gmail.com'
    })

    expect(calls).toEqual([
      [
        'forward_email',
        expect.objectContaining({
          messageId: 'runpod-new-m1',
          to: ['sinistercraftnetwork@gmail.com']
        })
      ]
    ])
  })

  it('replies to the newest message in the conversation named', async () => {
    const { tools, calls } = setUp()

    await tools.write_email.handler({ email: 'Sinistercraftnetwork', body: 'Got it, thanks!' })

    expect(calls).toEqual([
      [
        'reply_email',
        expect.objectContaining({ messageId: 'sinister-m2', body: 'Got it, thanks!' })
      ]
    ])
  })

  it('replies to their newest when the words find several of theirs', async () => {
    // "Reply to Sinistercraftnetwork's email" found two and was refused. The
    // approval card names the email, so taking the newest is caught there.
    h.inbox.push({
      id: 'sinister-old',
      subject: 'Re: tests email',
      from: 'Sinistercraftnetwork <sinistercraftnetwork@gmail.com>',
      updatedAt: 2
    })
    h.messages.set('sinister-old', [
      { id: 'sinister-old-m1', threadId: 'sinister-old', attachments: [] }
    ])
    const { tools, calls } = setUp()

    await tools.write_email.handler({ email: "Sinistercraftnetwork's email", body: 'Got it' })

    expect(calls).toEqual([['reply_email', expect.objectContaining({ messageId: 'sinister-m2' })]])
  })

  it('drafts a reply to an email for its sender, under its subject', async () => {
    const { tools, calls } = setUp()

    await tools.write_email.handler({
      action: 'draft',
      email: 'the latest Runpod email',
      body: "Thanks, I'll take a look."
    })

    expect(calls).toEqual([
      [
        'save_email_draft',
        expect.objectContaining({ to: ['news@runpod.io'], subject: 'Re: Runpod Weekly' })
      ]
    ])
  })

  it("replies to their newest message, not the person's own", async () => {
    // The newest message in the thread was the account's own earlier reply.
    h.messages.set('sinister', [
      { id: 'sinister-m1', threadId: 'sinister', attachments: [] },
      { id: 'sinister-m2', threadId: 'sinister', attachments: [], from: 'Me <me@example.com>' }
    ])
    const { tools, calls } = setUp()

    await tools.write_email.handler({ email: 'Sinistercraftnetwork', body: 'Got it, thanks!' })

    expect(calls).toEqual([['reply_email', expect.objectContaining({ messageId: 'sinister-m1' })]])
  })

  it('sends nothing, and says what is missing, without an address', async () => {
    const { tools, calls } = setUp()

    const result: unknown = await tools.write_email.handler({ subject: 'Hi', body: 'Hello' })

    expect(calls).toEqual([])
    expect(String(result)).toContain('to')
  })

  it('saves a draft only through the Drafts tool', async () => {
    const { tools, calls } = setUp()

    await tools.write_email.handler({ action: 'draft', to: ['a@b.c'], subject: 'S', body: 'B' })

    expect(calls.map(([name]) => name)).toEqual(['save_email_draft'])
  })
})

describe('organize_email', () => {
  it('moves one email to the Trash through move_email', async () => {
    const { tools, calls } = setUp()

    await tools.organize_email.handler({ action: 'trash', email: 'Wtf. from Reddit' })

    expect(calls).toEqual([
      ['move_email', expect.objectContaining({ mailbox: 'Trash', threadId: 'reddit' })]
    ])
  })

  it('acts on every match through batch_email, only when told every', async () => {
    const { tools, calls } = setUp()

    await tools.organize_email.handler({ action: 'mark_read', matching: 'Instagram', every: true })

    expect(calls).toEqual([
      ['batch_email', expect.objectContaining({ action: 'mark_read', query: 'Instagram' })]
    ])
  })

  it('reads matching without every as one email, and lists several', async () => {
    // Llama 3.1 8B passed matching "Reddit" for one Reddit email, and the card
    // asked to move 25 of them to the Trash.
    h.inbox.push({
      id: 'reddit-2',
      subject: 'Holy moly',
      from: 'Reddit <noreply@redditmail.com>',
      updatedAt: 6
    })
    const { tools, calls } = setUp()

    const result: unknown = await tools.organize_email.handler({
      action: 'trash',
      matching: 'Reddit'
    })

    expect(calls).toEqual([])
    expect(String(result)).toContain('More than one email')
    expect(String(result)).toContain('every: true')

    await tools.organize_email.handler({ action: 'trash', matching: 'Wtf.' })
    expect(calls).toEqual([
      ['move_email', expect.objectContaining({ mailbox: 'Trash', threadId: 'reddit' })]
    ])
  })

  it('will not guess between two emails the words both find', async () => {
    const { tools, calls } = setUp()

    const result: unknown = await tools.organize_email.handler({
      action: 'archive',
      email: 'Runpod'
    })

    expect(calls).toEqual([])
    expect(String(result)).toContain('More than one email')
  })
})

describe('open_email and find_email', () => {
  it('opens the newest of several matches, which costs nothing to get wrong', async () => {
    const { tools, calls } = setUp()

    await tools.open_email.handler({ email: 'Runpod' })

    expect(calls).toEqual([['read_email', expect.objectContaining({ messageId: 'runpod-new-m1' })]])
  })

  it('searches with words and lists the newest without them', async () => {
    const { tools, calls } = setUp()

    await tools.find_email.handler({ words: 'security alert' })
    await tools.find_email.handler({ mailbox: 'Trash' })

    expect(calls).toEqual([
      ['search_email', expect.objectContaining({ query: 'security alert' })],
      ['list_threads', expect.objectContaining({ mailbox: 'Trash' })]
    ])
  })
})

describe('pickAttachment', () => {
  const files = [
    { id: 'a1', filename: 'invoice-1043.pdf' },
    { id: 'a2', filename: 'photo.jpg' }
  ]

  it('takes an id, a number in the list, or part of a name', () => {
    expect(pickAttachment(files, 'a2')?.filename).toBe('photo.jpg')
    expect(pickAttachment(files, '1')?.filename).toBe('invoice-1043.pdf')
    expect(pickAttachment(files, 'invoice')?.id).toBe('a1')
    expect(pickAttachment(files, 'missing')).toBeUndefined()
  })
})
