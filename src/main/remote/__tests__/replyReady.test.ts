import { describe, expect, it } from 'vitest'
import type { ClientChannel } from '../../clients/ClientChannel'
import { notifyReplyReady, replyPreview, REPLY_READY_CAPABILITY } from '../replyReady'

function phone(id: string, capabilities: string[] = [REPLY_READY_CAPABILITY]) {
  const sent: Array<{ channel: string; payload: unknown }> = []
  const client = {
    id,
    capabilities,
    send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
    isAlive: () => true
  } as unknown as ClientChannel
  return { client, sent }
}

describe('telling the phone its answer is ready', () => {
  it('goes to the phone that asked, on every connection it has, and to no other', () => {
    // The app's own connection and the background one share the device's id.
    const asker = phone('remote:aaa')
    const askerAgain = phone('remote:aaa')
    const other = phone('remote:bbb')

    const sent = notifyReplyReady(
      asker.client,
      { conversationId: 'c1', title: 'Budget', content: 'Here is the budget.' },
      [asker.client, askerAgain.client, other.client]
    )

    expect(sent).toBe(2)
    expect(other.sent).toHaveLength(0)
    expect(asker.sent[0]).toMatchObject({
      channel: 'remote:notification',
      payload: { kind: 'reply-ready', title: 'Budget', conversationId: 'c1' }
    })
  })

  it('is not sent to a phone build that makes this notification itself', () => {
    const old = phone('remote:aaa', [])
    expect(
      notifyReplyReady(old.client, { conversationId: 'c1', content: 'Hi' }, [old.client])
    ).toBe(0)
  })

  it('says nothing when there is nothing to read', () => {
    const asker = phone('remote:aaa')
    expect(
      notifyReplyReady(asker.client, { conversationId: 'c1', content: '  ' }, [asker.client])
    ).toBe(0)
  })

  it('names an untitled chat plainly', () => {
    const asker = phone('remote:aaa')
    notifyReplyReady(asker.client, { conversationId: 'c1', content: 'Yes.' }, [asker.client])
    expect(asker.sent[0].payload).toMatchObject({ title: 'Your answer is ready', body: 'Yes.' })
  })
})

describe('replyPreview', () => {
  it('reads as plain text, without code or markdown marks', () => {
    expect(replyPreview('## Done\n\nI moved **3 files** to [Photos](x).\n```\nmv a b\n```')).toBe(
      'Done I moved 3 files to Photos.'
    )
  })

  it('is cut to a couple of lines', () => {
    const preview = replyPreview('word '.repeat(100))
    expect(preview.length).toBeLessThanOrEqual(140)
    expect(preview.endsWith('…')).toBe(true)
  })
})
