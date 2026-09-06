import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { generateRemoteCertificate, type RemoteCertificate } from '../certificate'
import { PairingService, type PairedDevice, type PairedDeviceStore } from '../pairing'
import { MAX_RESPONSE_BYTES, PROTOCOL_VERSION, RemoteBridge } from '../RemoteBridge'
import { detachAllRemoteClients } from '../../clients/clientRegistry'
import type { ServerFrame } from '../protocol'

/**
 * What happens when a handler returns more than a phone can hold.
 *
 * This is not a hypothetical limit. `conversations:list` returns every conversation
 * with every message, and against a real store that was 123MB of JSON. A WebSocket
 * message is buffered whole before the client can look at it, so the phone died with
 * `OutOfMemoryError` inside OkHttp's reader thread — where it cannot be caught, and
 * where it takes the process with it.
 *
 * From the user's side that looked like "it won't connect": the connection succeeded,
 * and the app vanished a second later. Reopening reconnected and did it again.
 *
 * The specific channels are fixed separately. This pins the guard that makes the
 * whole *class* impossible, so no handler added later can kill the client that
 * called it.
 */
describe('a reply too large to send', () => {
  let certificate: RemoteCertificate
  let stored: PairedDevice | null
  let pairing: PairingService
  let bridge: RemoteBridge
  let port: number

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
    detachAllRemoteClients()
    pairing = new PairingService(store)

    bridge = new RemoteBridge(pairing, certificate, (channel) =>
      channel === 'conversations:list'
        ? () => [{ id: 'c1', content: 'x'.repeat(MAX_RESPONSE_BYTES + 1024) }]
        : channel === 'conversations:list-summaries'
          ? () => [{ id: 'c1', title: 'Small', messageCount: 4000 }]
          : undefined
    )
    port = await bridge.start(0)
  })

  afterEach(async () => {
    await bridge.stop()
    detachAllRemoteClients()
  })

  async function connected(): Promise<WebSocket> {
    const socket = new WebSocket(`wss://127.0.0.1:${port}`, { ca: [certificate.certPem] })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })

    const session = pairing.beginPairing()
    socket.send(
      JSON.stringify({ type: 'pair', protocolVersion: PROTOCOL_VERSION, secret: session.secret })
    )
    await nextFrame(socket)
    return socket
  }

  function nextFrame(socket: WebSocket): Promise<ServerFrame> {
    return new Promise((resolve, reject) => {
      socket.once('message', (raw: Buffer) =>
        resolve(JSON.parse(raw.toString('utf8')) as ServerFrame)
      )
      socket.once('error', reject)
    })
  }

  it('answers with an error rather than sending it', async () => {
    const socket = await connected()
    socket.send(
      JSON.stringify({ type: 'invoke', id: '1', channel: 'conversations:list', args: [] })
    )

    const frame = await nextFrame(socket)

    expect(frame.type).toBe('result')
    if (frame.type !== 'result') return
    expect(frame.ok).toBe(false)
    if (frame.ok) return
    expect(frame.error.code).toBe('response-too-large')
    socket.close()
  })

  it('keeps the error small enough to actually arrive', async () => {
    // The failure mode this exists to prevent, reintroduced by carelessness: an
    // error that quotes the payload back is the same size as the payload.
    const socket = await connected()
    socket.send(
      JSON.stringify({ type: 'invoke', id: '1', channel: 'conversations:list', args: [] })
    )

    const raw = await new Promise<Buffer>((resolve) => {
      socket.once('message', (data: Buffer) => resolve(data))
    })

    expect(raw.byteLength).toBeLessThan(1024)
    socket.close()
  })

  it('leaves the connection usable afterwards', async () => {
    // A refusal must not be a disconnection. The user asked for one thing that was
    // too big; everything else still works, and the app should stay up.
    const socket = await connected()
    socket.send(
      JSON.stringify({ type: 'invoke', id: '1', channel: 'conversations:list', args: [] })
    )
    await nextFrame(socket)

    socket.send(
      JSON.stringify({
        type: 'invoke',
        id: '2',
        channel: 'conversations:list-summaries',
        args: []
      })
    )
    const frame = await nextFrame(socket)

    expect(frame.type).toBe('result')
    if (frame.type !== 'result') return
    expect(frame.ok).toBe(true)
    socket.close()
  })

  it('sends an ordinary reply untouched', async () => {
    // The guard must not be so eager that it breaks the normal case.
    const socket = await connected()
    socket.send(
      JSON.stringify({
        type: 'invoke',
        id: '1',
        channel: 'conversations:list-summaries',
        args: []
      })
    )

    const frame = await nextFrame(socket)

    expect(frame.type).toBe('result')
    if (frame.type !== 'result' || !frame.ok) throw new Error('a small reply was refused')
    expect(frame.result).toEqual([{ id: 'c1', title: 'Small', messageCount: 4000 }])
    socket.close()
  })
})
