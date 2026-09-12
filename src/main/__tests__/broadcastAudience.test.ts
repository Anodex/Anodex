import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { ClientChannel } from '@main/clients/ClientChannel'

/**
 * Who hears about a change, and who is spared hearing about their own.
 *
 * Reported from a phone: a conversation the computer was actively working on sat
 * frozen on the last turn the phone happened to have loaded. Both are windows onto
 * one machine doing one piece of work, so both should be watching it.
 *
 * The cause was a rule that had only ever been thought through in one direction.
 * Conversation saves were announced `if (isRemoteCall(event))` — written so a
 * renderer would not be told about its own edit mid-keystroke, which is right. But
 * it made "the author already knows" and "the author is a window" the same
 * condition, so a save by the desktop was announced to *nobody* and the phone was
 * never told anything at all.
 *
 * Excluding the author by identity gets the intended behaviour in both directions,
 * and these tests pin the two halves separately, because it is the second one that
 * was missing and it would be easy to reintroduce.
 */
const windows: Array<{ id: number; destroyed: boolean; sent: Array<[string, unknown]> }> = []

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () =>
      windows.map((w) => ({
        isDestroyed: () => w.destroyed,
        webContents: {
          id: w.id,
          isDestroyed: () => w.destroyed,
          send: (channel: string, payload: unknown) => w.sent.push([channel, payload])
        }
      }))
  }
}))

const remotes: ClientChannel[] = []
const muted = new Set<string>()
vi.mock('@main/clients/clientRegistry', () => ({
  activeRemoteClients: () => remotes,
  wantsLiveTokens: (c: ClientChannel) => !muted.has(c.id)
}))

const { broadcastToOtherClients, broadcastToWindows, broadcastLiveToken } =
  await import('../broadcast')

function fakeWindow(id: number) {
  const w = { id, destroyed: false, sent: [] as Array<[string, unknown]> }
  windows.push(w)
  return w
}

function fakeRemote(id: string) {
  const sent: Array<[string, unknown]> = []
  const client: ClientChannel = {
    id,
    send: (channel, payload) => sent.push([channel, payload]),
    isAlive: () => true
  }
  remotes.push(client)
  return { client, sent }
}

beforeEach(() => {
  windows.length = 0
  remotes.length = 0
  muted.clear()
})

describe('broadcastToOtherClients', () => {
  it('tells the phone when the computer saved the conversation', () => {
    // The reported bug, stated as a test. The desktop writes a turn; the phone is
    // holding the same chat and has to find out. Previously this announced nothing,
    // because the author was a window.
    const desktop = fakeWindow(1)
    const phone = fakeRemote('remote:pixel')
    const author: ClientChannel = { id: 'window:1', send: () => {}, isAlive: () => true }

    broadcastToOtherClients(author, 'conversations:changed', 'c_060618fe')

    expect(phone.sent).toEqual([['conversations:changed', 'c_060618fe']])
    expect(desktop.sent).toEqual([])
  })

  it('tells the computer when the phone saved it', () => {
    // The direction that already worked. It has to keep working.
    const desktop = fakeWindow(1)
    const phone = fakeRemote('remote:pixel')

    broadcastToOtherClients(phone.client, 'conversations:changed', 'c_060618fe')

    expect(desktop.sent).toEqual([['conversations:changed', 'c_060618fe']])
    expect(phone.sent).toEqual([])
  })

  it('never echoes a change back to whoever made it', () => {
    // The reason the original gate existed: a renderer told about its own write
    // reloads underneath the edit that caused it.
    const author = fakeWindow(1)
    fakeWindow(2)

    broadcastToOtherClients(
      { id: 'window:1', send: () => {}, isAlive: () => true },
      'conversations:changed',
      'c_1'
    )

    expect(author.sent).toEqual([])
    expect(windows[1].sent).toHaveLength(1)
  })

  it('reaches every other client, not just the first', () => {
    const a = fakeWindow(1)
    const b = fakeWindow(2)
    const phone = fakeRemote('remote:pixel')

    broadcastToOtherClients(
      { id: 'window:9', send: () => {}, isAlive: () => true },
      'conversations:changed',
      'c_1'
    )

    expect(a.sent).toHaveLength(1)
    expect(b.sent).toHaveLength(1)
    expect(phone.sent).toHaveLength(1)
  })

  it('skips a window whose frame is gone', () => {
    // Same disposal hazard `sendToWindow` exists for: during a generation these
    // fire per token, so one dead frame would otherwise be thousands of throws.
    const dead = fakeWindow(1)
    dead.destroyed = true

    expect(() =>
      broadcastToOtherClients(
        { id: 'window:9', send: () => {}, isAlive: () => true },
        'conversations:changed',
        'c_1'
      )
    ).not.toThrow()
    expect(dead.sent).toEqual([])
  })
})

describe('broadcastToWindows', () => {
  it('reaches the phone as well as the windows', () => {
    // What makes a streamed turn watchable from both places. Display events use
    // this rather than replying only to whoever started the turn.
    const desktop = fakeWindow(1)
    const phone = fakeRemote('remote:pixel')

    broadcastToWindows('chat:stream', { conversationId: 'c_1', token: 'hi' })

    expect(desktop.sent).toHaveLength(1)
    expect(phone.sent).toEqual([['chat:stream', { conversationId: 'c_1', token: 'hi' }]])
  })

  it('delivers one payload to a remote, not Electron variadic args', () => {
    // A wire frame carries a single payload. Extra arguments are dropped rather
    // than silently mangled into something the phone would try to parse.
    const phone = fakeRemote('remote:pixel')

    broadcastToWindows('chat:stream', { token: 'a' }, { extra: true })

    expect(phone.sent).toEqual([['chat:stream', { token: 'a' }]])
  })
})

describe('broadcastLiveToken', () => {
  it('skips a phone that asked not to receive tokens', () => {
    // A turn is thousands of frames. On a metered connection that is somebody's data
    // allowance spent on a screen they may not be looking at.
    const desktop = fakeWindow(1)
    const phone = fakeRemote('remote:pixel')
    muted.add('remote:pixel')

    broadcastLiveToken('chat:stream', { conversationId: 'c_1', token: 'hi' })

    expect(phone.sent).toEqual([])
    // The computer's own window is never skipped: the preference is about a
    // connection paid for by the megabyte, which a renderer in-process is not.
    expect(desktop.sent).toHaveLength(1)
  })

  it('sends to a phone that has said nothing', () => {
    // The default, and the behaviour this had before the preference existed. A
    // client that has not asked for less has not asked for less.
    const phone = fakeRemote('remote:pixel')

    broadcastLiveToken('chat:stream', { token: 'hi' })

    expect(phone.sent).toHaveLength(1)
  })

  it('mutes one client without muting another', () => {
    const quiet = fakeRemote('remote:on-a-train')
    const loud = fakeRemote('remote:at-home')
    muted.add('remote:on-a-train')

    broadcastLiveToken('chat:stream', { token: 'hi' })

    expect(quiet.sent).toEqual([])
    expect(loud.sent).toHaveLength(1)
  })
})
