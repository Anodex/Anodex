import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { generateRemoteCertificate, type RemoteCertificate } from '../certificate'
import { PairingService, type PairedDevice, type PairedDeviceStore } from '../pairing'
import { PROTOCOL_VERSION, RemoteBridge } from '../RemoteBridge'
import { detachAllRemoteClients } from '../../clients/clientRegistry'
import type { ServerFrame } from '../protocol'

/**
 * Handing the phone a public address it can use from mobile data.
 *
 * This is the entire mechanism by which the app works away from home: the phone
 * stores the addresses it is told at pairing and at every reconnect, and tries
 * them in order. If the forwarded address never reaches that list, the port can
 * be open on the router and the phone will still never dial it — a failure that
 * looks exactly like the forwarding not working, in a place the user cannot see.
 */
describe('telling the phone where to find this machine', () => {
  let certificate: RemoteCertificate
  let stored: PairedDevice | null
  let pairing: PairingService
  let bridge: RemoteBridge | null = null
  let external: string | null

  const store: PairedDeviceStore = {
    read: () => stored,
    write: (device) => {
      stored = device
    }
  }

  beforeAll(async () => {
    certificate = await generateRemoteCertificate('Anodex Test')
  }, 30_000)

  beforeEach(() => {
    stored = null
    external = null
    detachAllRemoteClients()
    pairing = new PairingService(store)
  })

  afterEach(async () => {
    await bridge?.stop()
    bridge = null
    detachAllRemoteClients()
  })

  /** Starts a bridge whose public address is whatever `external` is *right now*. */
  async function start(): Promise<number> {
    bridge = new RemoteBridge(pairing, certificate, undefined, () => external)
    return bridge.start(0)
  }

  function connect(port: number): Promise<WebSocket> {
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

  async function pair(port: number): Promise<Extract<ServerFrame, { type: 'paired' }>> {
    const socket = await connect(port)
    const session = pairing.beginPairing()
    socket.send(
      JSON.stringify({ type: 'pair', protocolVersion: PROTOCOL_VERSION, secret: session.secret })
    )
    const frame = await nextFrame(socket)
    socket.close()
    if (frame.type !== 'paired') throw new Error(`did not pair: ${JSON.stringify(frame)}`)
    return frame
  }

  async function reconnect(port: number, deviceKey: string): Promise<string[]> {
    const socket = await connect(port)
    socket.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION, deviceKey }))
    const frame = await nextFrame(socket)
    socket.close()
    if (frame.type !== 'welcome') throw new Error(`not welcomed: ${JSON.stringify(frame)}`)
    return frame.addresses
  }

  it('includes the public address in what the phone is told at pairing', async () => {
    external = '203.0.113.7'
    const port = await start()

    const paired = await pair(port)

    expect(paired.addresses).toContain('203.0.113.7')
  })

  it('puts the public address last, so the LAN is tried first', async () => {
    // Order is the phone's preference order. The forwarded route is the slowest
    // and the only one that leaves the house, so it must never be tried ahead of
    // an address that works at home.
    external = '203.0.113.7'
    const port = await start()

    const paired = await pair(port)

    expect(paired.addresses.at(-1)).toBe('203.0.113.7')
    expect(paired.addresses.length).toBeGreaterThan(1)
  })

  it('omits it entirely while internet access is off', async () => {
    external = null
    const port = await start()

    const paired = await pair(port)

    expect(paired.addresses.every((address) => address !== '203.0.113.7')).toBe(true)
  })

  it('picks up an address opened after the listener already started', async () => {
    // Resolved per handshake rather than captured at construction: the user can
    // turn forwarding on long after turning remote access on, and a phone that
    // reconnects afterwards has to learn about it without a restart. Capturing
    // the value once is the obvious implementation and it silently never updates.
    const port = await start()
    const paired = await pair(port)
    expect(paired.addresses).not.toContain('203.0.113.7')

    external = '203.0.113.7'

    expect(await reconnect(port, paired.deviceKey)).toContain('203.0.113.7')
  })

  it('drops it again when the user turns internet access back off', async () => {
    external = '203.0.113.7'
    const port = await start()
    const paired = await pair(port)

    external = null

    expect(await reconnect(port, paired.deviceKey)).not.toContain('203.0.113.7')
  })

  it('does not list the same address twice', async () => {
    // The public address can coincide with a local one on a machine with a real
    // routable address. A duplicate costs the phone a wasted connection attempt
    // against an address it has already just failed on.
    const probe = new RemoteBridge(pairing, certificate)
    await probe.start(0)
    const port = await start()
    const first = (await pair(port)).addresses[0]
    await probe.stop()

    await bridge?.stop()
    external = first
    const secondPort = await start()
    stored = null
    const paired = await pair(secondPort)

    expect(paired.addresses.filter((address) => address === first)).toHaveLength(1)
  })
})
