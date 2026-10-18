import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  threads: new Map<string, Array<{ subject: string; from: string }>>(),
  inbox: [] as Array<{ id: string; subject: string; from: string }>
}))

vi.mock('../../email/EmailService', () => ({
  emailService: {
    readMessage: () => Promise.reject(new Error('not a message id')),
    getThreadMessages: (id: string) =>
      h.threads.has(id)
        ? Promise.resolve(h.threads.get(id))
        : Promise.reject(new Error(`"${id}" is not a valid IMAP thread id.`)),
    // A plain substring search over subject and sender, as a server would.
    search: ({ query }: { query: string }) =>
      Promise.resolve(
        h.inbox.filter((thread) =>
          `${thread.subject} ${thread.from}`.toLowerCase().includes(query.toLowerCase())
        )
      )
  }
}))

const { resolveEmailTarget } = await import('../emailTarget')

beforeEach(() => {
  h.threads = new Map([
    ['thread-7', [{ subject: 'Wtf.', from: 'Reddit <noreply@redditmail.com>' }]]
  ])
  h.inbox = [
    { id: 'thread-7', subject: 'Wtf.', from: 'Reddit <noreply@redditmail.com>' },
    {
      id: 'thread-8',
      subject: 'Welcome to Google on your Windows',
      from: 'Google <no-reply@google.com>'
    },
    {
      id: 'thread-9',
      subject: 'anodex_ai, catch up',
      from: 'Instagram <notification@instagram.com>'
    },
    { id: 'thread-10', subject: 'anodex_ai, see more', from: 'Instagram <follow@instagram.com>' }
  ]
})

describe('resolveEmailTarget', () => {
  it('takes a real id, and names the email it is', async () => {
    expect(await resolveEmailTarget({ threadId: 'thread-7' })).toEqual({
      threadId: 'thread-7',
      label: '"Wtf." from Reddit <noreply@redditmail.com>'
    })
  })

  // Llama 3.1 8B passed exactly this as a thread id.
  it('finds the one email words passed in place of an id describe', async () => {
    expect((await resolveEmailTarget({ threadId: 'Reddit email titled Wtf.' })).threadId).toBe(
      'thread-7'
    )
    expect((await resolveEmailTarget({ threadId: 'the "Wtf." email' })).threadId).toBe('thread-7')
  })

  it('uses the id inside a listing line copied whole', async () => {
    const target = await resolveEmailTarget({
      threadId: '[threadId: thread-7; latestMessageId: m-1] Wtf.'
    })
    expect(target.threadId).toBe('thread-7')
  })

  it('lists the emails words match rather than picking one', async () => {
    await expect(resolveEmailTarget({ threadId: 'Instagram' })).rejects.toThrow(
      /More than one email matches "Instagram"[\s\S]*thread-9[\s\S]*thread-10/
    )
  })

  it('says so when nothing matches', async () => {
    await expect(resolveEmailTarget({ threadId: 'Cloudflare' })).rejects.toThrow(
      'No email matches "Cloudflare".'
    )
  })
})

describe('resolveEmailTarget with a sender beside the subject', () => {
  it('finds "Wtf." from Reddit over other Reddit emails that say wtf', async () => {
    h.inbox.push({
      id: 'thread-11',
      subject: 'Wtf is this defacement even about?',
      from: 'Reddit <noreply@redditmail.com>'
    })
    h.threads.set('thread-11', [
      { subject: 'Wtf is this defacement even about?', from: 'Reddit <noreply@redditmail.com>' }
    ])

    expect((await resolveEmailTarget({ threadId: 'Wtf. from Reddit' })).threadId).toBe('thread-7')
  })
})
