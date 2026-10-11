import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { generateRemoteCertificate, type RemoteCertificate } from '../certificate'
import { PairingService, type PairedDevice, type PairedDeviceStore } from '../pairing'
import { MAX_BUFFERED_BYTES, RemoteBridge } from '../RemoteBridge'
import { detachAllRemoteClients } from '../../clients/clientRegistry'
import { farewellCode } from '@shared/remoteFarewell'

/**
 * Knowing when a phone has gone, against a real bridge and real sockets.
 *
 * A phone that left Wi-Fi or died used to hold its connection open, and count as
 * connected, for as long as the operating system took to give up on it. And sleep
 * closed the listener for good. Both are about the connection's lifetime, which is
 * only worth testing with sockets that actually open and close.
 */
describe('the remote connection lifetime', () => {
  let certificate: RemoteCertificate
  let stored: PairedDevice[]
  let bridge: RemoteBridge
  let port: number
  const opened: WebSocket[] = []

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
    bridge = new RemoteBridge(new PairingService(store), certificate)
    port = await bridge.start(0)
  })

  afterEach(async () => {
    for (const socket of opened.splice(0)) socket.terminate()
    await bridge.stop()
    detachAllRemoteClients()
  })

  /** A phone that has connected. `answers: false` is one that has silently gone. */
  function connect(answers = true): Promise<WebSocket> {
    const socket = new WebSocket(`wss://127.0.0.1:${port}`, {
      ca: [certificate.certPem],
      autoPong: answers
    })
    opened.push(socket)
    return new Promise((resolve, reject) => {
      socket.once('open', () => resolve(socket))
      socket.once('error', reject)
    })
  }

  const closed = (socket: WebSocket): Promise<number> =>
    new Promise((resolve) => socket.once('close', (code: number) => resolve(code)))

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 100))

  it('drops a phone that stopped answering, and keeps one that answers', async () => {
    const gone = await connect(false)
    const here = await connect(true)
    const goneClosed = closed(gone)
    let hereClosed = false
    here.once('close', () => {
      hereClosed = true
    })

    bridge.checkHeartbeats() // both were heard on connecting; both are pinged
    await settle()
    bridge.checkHeartbeats() // only the one that answered has been heard since

    expect(await goneClosed).toBe(1006)
    await settle()
    expect(hereClosed).toBe(false)
  })

  it('says why on sleep, and still lets the phone back in', async () => {
    const before = await connect()
    const code = closed(before)

    await bridge.goodbye('sleeping')

    expect(await code).toBe(farewellCode('sleeping'))
    expect(bridge.listening).toBe(true)
    const after = await connect()
    expect(after.readyState).toBe(WebSocket.OPEN)
  })

  it('treats a phone with too much waiting for it as gone', async () => {
    const socket = await connect()
    const code = closed(socket)
    const [server] = [
      ...(bridge as unknown as { sockets: { clients: Set<WebSocket> } }).sockets.clients
    ]
    Object.defineProperty(server, 'bufferedAmount', { value: MAX_BUFFERED_BYTES + 1 })

    ;(bridge as unknown as { sendNow(s: WebSocket, f: unknown): void }).sendNow(server, {
      type: 'pong'
    })

    expect(await code).toBe(1006)
  })
})
