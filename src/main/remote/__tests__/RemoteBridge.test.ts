import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { X509Certificate } from 'node:crypto'
import { generateRemoteCertificate, type RemoteCertificate } from '../certificate'
import { PairingService, type PairedDevice, type PairedDeviceStore } from '../pairing'
import { PROTOCOL_VERSION, RemoteBridge } from '../RemoteBridge'
import {
  activeRemoteClients,
  detachAllRemoteClients,
  resolveClientChannel
} from '../../clients/clientRegistry'
import type { ServerFrame } from '../protocol'

/**
 * The bridge, end to end over a real TLS socket.
 *
 * Not mocked: a real certificate, a real handshake, real pairing, and a real
 * handler invoked through the registry. The whole point of this file is that the
 * pieces built separately actually add up to a working connection — everything
 * else in this directory tests them apart.
 */
describe('RemoteBridge', () => {
  let certificate: RemoteCertificate
  let stored: PairedDevice | null
  let pairing: PairingService
  let bridge: RemoteBridge
  let port: number
  let handled: Array<{ channel: string; args: unknown[]; event: unknown }>

  const store: PairedDeviceStore = {
    read: () => stored,
    write: (device) => {
      stored = device
    }
  }

  beforeAll(async () => {
    certificate = await generateRemoteCertificate('Anodex Test')
  }, 30_000)

  beforeEach(async () => {
    stored = null
    handled = []
    detachAllRemoteClients()
    pairing = new PairingService(store)
    // A stand-in for the ipcMain registry, so a call can be observed arriving.
    bridge = new RemoteBridge(pairing, certificate, (channel) =>
      channel === 'chat:send'
        ? (event, ...args) => {
            handled.push({ channel, args, event })
            return { ok: true, value: { messageId: 'm1' } }
          }
        : undefined
    )
    port = await bridge.start(0)
  })

  afterEach(async () => {
    await bridge.stop()
    detachAllRemoteClients()
  })

  /** A client that trusts exactly this certificate, the way the phone will. */
  function connect(): Promise<WebSocket> {
    // Trusts this certificate and nothing else, which is what the phone's pinned
    // trust manager does. No `checkServerIdentity` override: the certificate's SAN
    // covers 127.0.0.1, so full verification genuinely passes here rather than
    // being switched off to make the test go green.
    const socket = new WebSocket(`wss://127.0.0.1:${port}`, { ca: [certificate.certPem] })
    return new Promise((resolve, reject) => {
      socket.once('open', () => resolve(socket))
      socket.once('error', reject)
    })
  }

  function nextFrame(socket: WebSocket): Promise<ServerFrame> {
    return new Promise((resolve) => {
      socket.once('message', (raw: Buffer) =>
        resolve(JSON.parse(raw.toString('utf8')) as ServerFrame)
      )
    })
  }

  async function pairPhone(socket: WebSocket): Promise<string> {
    const session = pairing.beginPairing()
    socket.send(
      JSON.stringify({
        type: 'pair',
        protocolVersion: PROTOCOL_VERSION,
        secret: session.secret,
        deviceName: 'Pixel'
      })
    )
    const frame = await nextFrame(socket)
    if (frame.type !== 'paired') throw new Error(`expected paired, got ${frame.type}`)
    return frame.deviceKey
  }

  it('serves the certificate the phone is told to pin', async () => {
    // If these disagree the pin can never match, and every connection is refused
    // for a reason that looks nothing like its cause.
    const served = new X509Certificate(certificate.certPem)
    expect(certificate.sha256).toBe(served.fingerprint256.replace(/:/g, '').toLowerCase())

    const socket = await connect()
    expect(socket.readyState).toBe(WebSocket.OPEN)
    socket.close()
  })

  it('pairs, then authenticates a reconnect with the issued key', async () => {
    const first = await connect()
    const deviceKey = await pairPhone(first)
    expect(pairing.paired()?.name).toBe('Pixel')
    first.close()

    const second = await connect()
    second.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION, deviceKey }))
    const welcome = await nextFrame(second)

    expect(welcome.type).toBe('welcome')
    second.close()
  })

  it('registers the phone as a client so events reach it', async () => {
    const socket = await connect()
    await pairPhone(socket)

    // This is what makes broadcasts and approval prompts reach the phone at all.
    expect(activeRemoteClients()).toHaveLength(1)
    expect(activeRemoteClients()[0].id).toMatch(/^remote:/)
    socket.close()
  })

  it('refuses an unpaired client rather than letting it invoke anything', async () => {
    const socket = await connect()
    socket.send(
      JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION, deviceKey: 'guessed' })
    )
    const frame = await nextFrame(socket)

    expect(frame.type).toBe('refused')
    if (frame.type !== 'refused') return
    expect(frame.code).toBe('no-session')
    expect(activeRemoteClients()).toHaveLength(0)
  })

  it('will not invoke anything before the handshake', async () => {
    // The whole security model rests on this: an unauthenticated socket can do
    // nothing but say who it is.
    const socket = await connect()
    socket.send(JSON.stringify({ type: 'invoke', id: '1', channel: 'chat:send', args: [] }))
    const frame = await nextFrame(socket)

    expect(frame.type).toBe('refused')
    if (frame.type !== 'refused') return
    expect(frame.code).toBe('not-authenticated')
    expect(handled).toHaveLength(0)
  })

  it('refuses a protocol major it does not speak, and says so', async () => {
    const socket = await connect()
    socket.send(JSON.stringify({ type: 'pair', protocolVersion: '99.0.0', secret: 'x' }))
    const frame = await nextFrame(socket)

    expect(frame.type).toBe('refused')
    if (frame.type !== 'refused') return
    expect(frame.code).toBe('protocol-mismatch')
    // A named, explained failure rather than a silent hang (§4).
    expect(frame.message).toContain('Update the app')
  })

  it('refuses a desktop-only channel by name instead of hanging', async () => {
    const socket = await connect()
    await pairPhone(socket)

    socket.send(
      JSON.stringify({ type: 'invoke', id: 'x', channel: 'terminal:write', args: ['rm -rf /'] })
    )
    const frame = await nextFrame(socket)

    expect(frame.type).toBe('result')
    if (frame.type !== 'result' || frame.ok) throw new Error('expected a failure result')
    expect(frame.error.code).toBe('desktop-only')
    socket.close()
  })

  it('re-dispatches an authenticated call to the handler, arguments intact', async () => {
    // The property that makes this a bridge rather than a socket that accepts JSON.
    const socket = await connect()
    await pairPhone(socket)

    socket.send(
      JSON.stringify({
        type: 'invoke',
        id: 'call-1',
        channel: 'chat:send',
        args: [{ conversationId: 'c1', messageId: 'm1', text: 'hello from the phone' }]
      })
    )
    const frame = await nextFrame(socket)

    expect(handled).toHaveLength(1)
    expect(handled[0].channel).toBe('chat:send')
    expect(handled[0].args[0]).toMatchObject({ text: 'hello from the phone' })

    expect(frame.type).toBe('result')
    if (frame.type !== 'result' || !frame.ok) throw new Error('expected a successful result')
    expect(frame.id).toBe('call-1')
    expect(frame.result).toEqual({ ok: true, value: { messageId: 'm1' } })
    socket.close()
  })

  it('gives the handler a client channel to stream back through', async () => {
    // The first remote chat:send failed with "Cannot read properties of undefined
    // (reading 'sender')" — the bridge passed no event, and chat streams through
    // one. It failed *after* a successful handshake, so everything looked connected
    // until a message was actually sent.
    const socket = await connect()
    await pairPhone(socket)

    socket.send(
      JSON.stringify({ type: 'invoke', id: 'c', channel: 'chat:send', args: [{ prompt: 'hi' }] })
    )
    await nextFrame(socket)

    expect(handled).toHaveLength(1)
    const client = resolveClientChannel(handled[0].event)
    expect(client.id).toMatch(/^remote:/)
    expect(client.isAlive()).toBe(true)

    // And it really reaches the phone, rather than merely existing.
    client.send('chat:stream', { conversationId: 'c1', messageId: 'm1', token: 'hello' })
    const streamed = await nextFrame(socket)

    expect(streamed.type).toBe('event')
    if (streamed.type !== 'event') return
    expect(streamed.channel).toBe('chat:stream')
    socket.close()
  })

  it('reports an unknown channel rather than leaving the phone waiting', async () => {
    const socket = await connect()
    await pairPhone(socket)

    socket.send(JSON.stringify({ type: 'invoke', id: 'q', channel: 'not:areal-channel', args: [] }))
    const frame = await nextFrame(socket)

    expect(frame.type).toBe('result')
    if (frame.type !== 'result' || frame.ok) throw new Error('expected a failure result')
    expect(frame.error.code).toBe('unknown-channel')
    socket.close()
  })

  it('rejects a malformed frame without dropping the connection', async () => {
    const socket = await connect()
    await pairPhone(socket)

    socket.send('not json at all')
    const frame = await nextFrame(socket)

    expect(frame.type).toBe('refused')
    if (frame.type !== 'refused') return
    expect(frame.code).toBe('not-json')
    expect(socket.readyState).toBe(WebSocket.OPEN)
    socket.close()
  })

  it('detaches the client when the socket closes', async () => {
    const socket = await connect()
    await pairPhone(socket)
    expect(activeRemoteClients()).toHaveLength(1)

    socket.close()
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(activeRemoteClients()).toHaveLength(0)
  })

  it('stops listening and drops everything on stop', async () => {
    const socket = await connect()
    await pairPhone(socket)

    await bridge.stop()

    expect(bridge.listening).toBe(false)
    expect(activeRemoteClients()).toHaveLength(0)
    await expect(connect()).rejects.toThrow()
  })
})
