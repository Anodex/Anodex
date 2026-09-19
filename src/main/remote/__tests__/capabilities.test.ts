import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { generateRemoteCertificate, type RemoteCertificate } from '../certificate'
import { PairingService, type PairedDevice, type PairedDeviceStore } from '../pairing'
import { PROTOCOL_VERSION, RemoteBridge } from '../RemoteBridge'
import { activeRemoteClients, detachAllRemoteClients } from '../../clients/clientRegistry'
import { hasCapability, parseCapabilities } from '../capabilities'
import type { ServerFrame } from '../protocol'

/**
 * Announcing a feature instead of demanding a version.
 *
 * The desktop and the phone ship from two repositories, so a user is routinely
 * running a pair of versions nobody tested together — a phone updated overnight
 * against a computer that has not been. `PROTOCOL_VERSION` cannot express that:
 * it is a hard gate that refuses the connection, which is right for a broken
 * frame format and wrong for a feature only one side has.
 *
 * These tests pin the part that has to keep working forever: that a peer which
 * says nothing is treated as a peer with no features rather than as a fault, in
 * both directions. That property is what lets a feature be removed from one side
 * alone — see `docs/HANDOFF_VOICE.md` §9.4.
 */
describe('reading a capability list', () => {
  it('treats anything that is not a list as no features', () => {
    // The case that matters: every phone built before this existed sends no
    // `capabilities` key at all.
    expect(parseCapabilities(undefined)).toEqual([])
    expect(parseCapabilities(null)).toEqual([])
    expect(parseCapabilities('voice.1')).toEqual([])
    expect(parseCapabilities({ voice: true })).toEqual([])
  })

  it('keeps the usable names and drops the rest', () => {
    // A malformed entry is a feature that will not be used. Rejecting the frame
    // instead would turn a cosmetic disagreement into a phone that cannot connect.
    expect(parseCapabilities(['voice.1', 7, '', null, 'files.2'])).toEqual(['voice.1', 'files.2'])
  })

  it('drops a name too long to be one', () => {
    expect(parseCapabilities(['x'.repeat(65)])).toEqual([])
    expect(parseCapabilities(['x'.repeat(64)])).toHaveLength(1)
  })

  it('collapses duplicates so counting entries counts features', () => {
    expect(parseCapabilities(['voice.1', 'voice.1'])).toEqual(['voice.1'])
  })

  it('stops reading a list longer than any real client sends', () => {
    // It arrives from the network before authentication, so the length is a
    // stranger's choice and cannot be unbounded.
    const many = Array.from({ length: 500 }, (_, index) => `cap.${index}`)
    expect(parseCapabilities(many)).toHaveLength(32)
  })

  it('reads an absent list as nothing announced', () => {
    expect(hasCapability(undefined, 'voice.1')).toBe(false)
    expect(hasCapability([], 'voice.1')).toBe(false)
    expect(hasCapability(['voice.1'], 'voice.1')).toBe(true)
    expect(hasCapability(['voice.2'], 'voice.1')).toBe(false)
  })
})

describe('capabilities across a real handshake', () => {
  let certificate: RemoteCertificate
  let stored: PairedDevice[]
  let pairing: PairingService
  let bridge: RemoteBridge
  let port: number

  const store: PairedDeviceStore = {
    read: () => stored,
    write: (devices) => {
      stored = devices
    }
  }

  beforeAll(async () => {
    certificate = await generateRemoteCertificate('Anodex Test')
  }, 30_000)

  beforeEach(async () => {
    stored = []
    detachAllRemoteClients()
    pairing = new PairingService(store)
    bridge = new RemoteBridge(pairing, certificate, () => undefined)
    port = await bridge.start(0)
  })

  afterEach(async () => {
    await bridge.stop()
    detachAllRemoteClients()
  })

  async function open(): Promise<WebSocket> {
    const socket = new WebSocket(`wss://127.0.0.1:${port}`, { ca: [certificate.certPem] })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })
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

  it('pairs a client that has never heard of capabilities', async () => {
    // The whole point. This frame is byte-for-byte what a shipped phone sends.
    const socket = await open()
    const session = pairing.beginPairing()
    socket.send(
      JSON.stringify({ type: 'pair', protocolVersion: PROTOCOL_VERSION, secret: session.secret })
    )

    const frame = await nextFrame(socket)

    expect(frame.type).toBe('paired')
    expect(activeRemoteClients()[0]?.capabilities).toEqual([])
    socket.close()
  })

  it('tells the phone what this computer can do', async () => {
    const socket = await open()
    const session = pairing.beginPairing()
    socket.send(
      JSON.stringify({ type: 'pair', protocolVersion: PROTOCOL_VERSION, secret: session.secret })
    )

    const frame = await nextFrame(socket)

    // Sent even when empty: a phone that receives the key knows the computer can
    // answer the question, which is different from a computer too old to be asked.
    expect(frame.type === 'paired' && Array.isArray(frame.capabilities)).toBe(true)
    socket.close()
  })

  it('remembers what the phone announced, for this connection', async () => {
    const socket = await open()
    const session = pairing.beginPairing()
    socket.send(
      JSON.stringify({
        type: 'pair',
        protocolVersion: PROTOCOL_VERSION,
        secret: session.secret,
        capabilities: ['voice.1', 'nonsense.9']
      })
    )
    await nextFrame(socket)

    const client = activeRemoteClients()[0]

    // Unrecognised names are kept rather than filtered: this end does not own the
    // vocabulary, and a capability the desktop gains later should not depend on
    // the phone having been parsed by a build that already knew the name.
    expect(client?.capabilities).toEqual(['voice.1', 'nonsense.9'])
    expect(hasCapability(client?.capabilities, 'voice.1')).toBe(true)
    socket.close()
  })

  it('reads the list again on every reconnect, not once at pairing', async () => {
    // A phone that updates announces a different list with the same device key.
    // Anything cached by device id would be stale in exactly the case the list
    // exists to cover.
    const first = await open()
    const session = pairing.beginPairing()
    first.send(
      JSON.stringify({
        type: 'pair',
        protocolVersion: PROTOCOL_VERSION,
        secret: session.secret,
        capabilities: []
      })
    )
    const paired = await nextFrame(first)
    expect(paired.type).toBe('paired')
    if (paired.type !== 'paired') return
    first.close()

    const second = await open()
    second.send(
      JSON.stringify({
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        deviceKey: paired.deviceKey,
        capabilities: ['voice.1']
      })
    )
    const welcome = await nextFrame(second)

    expect(welcome.type).toBe('welcome')
    expect(
      activeRemoteClients().some((client) => hasCapability(client.capabilities, 'voice.1'))
    ).toBe(true)
    second.close()
  })
})
