import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { generateRemoteCertificate, type RemoteCertificate } from '../certificate'
import { PairingService, type PairedDevice, type PairedDeviceStore } from '../pairing'
import { PROTOCOL_VERSION, RemoteBridge } from '../RemoteBridge'
import { activeRemoteClients, detachAllRemoteClients } from '../../clients/clientRegistry'
import type { ServerFrame } from '../protocol'

/**
 * The exact sequence the phone performs when a user finishes pairing.
 *
 * Reported behaviour: after typing the pairing details the app will not connect
 * until it is closed and reopened. Everything about that path is fast, concurrent
 * and hard to reason about from either side alone — the phone pairs on one
 * socket, immediately opens a second with the key it was just issued, and closes
 * the first — so this reproduces it against a real bridge rather than arguing
 * about it.
 */
describe('pairing then immediately reconnecting', () => {
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
    bridge = new RemoteBridge(pairing, certificate, () => undefined)
    port = await bridge.start(0)
  })

  afterEach(async () => {
    await bridge.stop()
    detachAllRemoteClients()
  })

  function connect(): Promise<WebSocket> {
    const socket = new WebSocket(`wss://127.0.0.1:${port}`, { ca: [certificate.certPem] })
    return new Promise((resolve, reject) => {
      socket.once('open', () => resolve(socket))
      socket.once('error', reject)
    })
  }

  function nextFrame(socket: WebSocket): Promise<ServerFrame> {
    return new Promise((resolve, reject) => {
      socket.once('message', (raw: Buffer) =>
        resolve(JSON.parse(raw.toString('utf8')) as ServerFrame)
      )
      socket.once('error', reject)
    })
  }

  it('accepts the issued key on a second socket while the first is closing', async () => {
    // This is the real sequence, ordered exactly as the phone does it: pair,
    // receive the key, open the next connection, and only then tear the pairing
    // socket down.
    const pairingSocket = await connect()
    const session = pairing.beginPairing()
    pairingSocket.send(
      JSON.stringify({
        type: 'pair',
        protocolVersion: PROTOCOL_VERSION,
        secret: session.secret,
        deviceName: 'Pixel'
      })
    )

    const paired = await nextFrame(pairingSocket)
    expect(paired.type).toBe('paired')
    if (paired.type !== 'paired') return

    const live = await connect()
    live.send(
      JSON.stringify({
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        deviceKey: paired.deviceKey
      })
    )

    // Closed after the second is already open, which is what the phone's `finally`
    // does and the ordering most likely to expose a shared-state problem.
    pairingSocket.close()

    const welcome = await nextFrame(live)
    expect(welcome.type, `expected welcome, got ${JSON.stringify(welcome)}`).toBe('welcome')

    live.close()
  })

  it('accepts the issued key even when the pairing socket closes first', async () => {
    // The other ordering, in case the phone's teardown wins the race.
    const pairingSocket = await connect()
    const session = pairing.beginPairing()
    pairingSocket.send(
      JSON.stringify({
        type: 'pair',
        protocolVersion: PROTOCOL_VERSION,
        secret: session.secret,
        deviceName: 'Pixel'
      })
    )

    const paired = await nextFrame(pairingSocket)
    if (paired.type !== 'paired') throw new Error('did not pair')
    pairingSocket.close()
    await new Promise((resolve) => setTimeout(resolve, 50))

    const live = await connect()
    live.send(
      JSON.stringify({
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        deviceKey: paired.deviceKey
      })
    )

    const welcome = await nextFrame(live)
    expect(welcome.type).toBe('welcome')
    live.close()
  })

  it('leaves exactly one client attached once the pairing socket is gone', async () => {
    // Two sockets exist briefly. If the pairing one never detaches, every broadcast
    // and every approval prompt is delivered twice for the rest of the session.
    const pairingSocket = await connect()
    const session = pairing.beginPairing()
    pairingSocket.send(
      JSON.stringify({ type: 'pair', protocolVersion: PROTOCOL_VERSION, secret: session.secret })
    )
    const paired = await nextFrame(pairingSocket)
    if (paired.type !== 'paired') throw new Error('did not pair')

    const live = await connect()
    live.send(
      JSON.stringify({
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        deviceKey: paired.deviceKey
      })
    )
    await nextFrame(live)

    pairingSocket.close()
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(activeRemoteClients()).toHaveLength(1)
    live.close()
  })

  it('a second hello with the same key is accepted, not treated as a stranger', async () => {
    // The phone reconnects on every drop, and a reconnect must never be mistaken
    // for a second device trying to muscle in.
    const first = await connect()
    const session = pairing.beginPairing()
    first.send(
      JSON.stringify({ type: 'pair', protocolVersion: PROTOCOL_VERSION, secret: session.secret })
    )
    const paired = await nextFrame(first)
    if (paired.type !== 'paired') throw new Error('did not pair')
    first.close()

    for (let attempt = 0; attempt < 3; attempt++) {
      const socket = await connect()
      socket.send(
        JSON.stringify({
          type: 'hello',
          protocolVersion: PROTOCOL_VERSION,
          deviceKey: paired.deviceKey
        })
      )
      const frame = await nextFrame(socket)
      expect(frame.type, `reconnect ${attempt + 1} was refused`).toBe('welcome')
      socket.close()
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  })
})
