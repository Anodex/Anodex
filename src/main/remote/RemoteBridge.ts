import { createServer, type Server as HttpsServer } from 'node:https'
import { WebSocketServer, type WebSocket } from 'ws'
import { createLogger } from '../utils/logger'
import type { ClientChannel } from '../clients/ClientChannel'
import {
  REMOTE_CLIENT,
  attachRemoteClient,
  detachAllRemoteClients,
  detachRemoteClient
} from '../clients/clientRegistry'
import { collectHostAddresses } from './addresses'
import { decideRemoteChannel } from './channelPolicy'
import { handlerFor, type IpcHandler } from './handlerRegistry'
import type { RemoteCertificate } from './certificate'
import type { PairingService } from './pairing'
import { MAX_FRAME_BYTES, parseClientFrame, versionsCompatible, type ServerFrame } from './protocol'

const log = createLogger('remote-bridge')

/**
 * The protocol this build speaks. Must match `protocol/anodex-protocol.json`.
 */
export const PROTOCOL_VERSION = '1.0.0'

/** How long an unauthenticated socket may stay open before it is dropped. */
const HANDSHAKE_TIMEOUT_MS = 10_000

/**
 * A TLS listener that lets one paired phone drive this machine's existing IPC
 * handlers.
 *
 * ## What this is, stated plainly
 *
 * An open port into an application that writes files, runs commands and ships a
 * terminal that is deliberately not sandboxed. For anyone who reaches it and
 * authenticates, this is remote code execution on the user's PC. That is not a
 * reason not to build it — it is the reason every constraint below is a
 * requirement rather than a preference.
 *
 * - **Off by default.** Nothing listens until the user turns it on in Settings.
 * - **One paired device**, enforced by `PairingService`, not by this class.
 * - **TLS with a pinned self-signed certificate.** No CA can vouch for a LAN
 *   address; the phone pins the certificate at pairing and refuses anything else.
 * - **Authenticate before anything else.** A socket that has not completed a
 *   `hello` or `pair` can do nothing but those, and is dropped after ten seconds.
 * - **Desktop-only channels are refused by name**, never silently.
 * - **Re-dispatch, never fork.** Calls go to the same handler functions the
 *   renderer uses, so a feature cannot exist on one client and not the other.
 */
export class RemoteBridge {
  private server: HttpsServer | null = null
  private sockets: WebSocketServer | null = null
  private sequence = 0

  constructor(
    private readonly pairing: PairingService,
    private readonly certificate: RemoteCertificate,
    /**
     * How a channel is resolved to its handler.
     *
     * Defaults to the real registry, so production re-dispatches to exactly the
     * functions the renderer uses (§3.2). Injectable so a test can prove a call
     * reaches a handler with the right arguments — the one property that makes
     * this a bridge rather than a socket that accepts JSON.
     */
    private readonly lookup: (channel: string) => IpcHandler | undefined = handlerFor,
    /**
     * A public address the phone can use from outside the home network, if the
     * user has asked for one. Resolved per handshake rather than captured, because
     * a forwarded port can be turned on and off while the listener keeps running.
     */
    private readonly externalAddress: () => string | null = () => null,
    /**
     * Where an authenticated client connected from.
     *
     * A peer outside the private ranges reached this machine through the router,
     * which is the only confirmation the user can get that their port forwarding
     * works without asking somebody else's server to look.
     */
    private readonly onPeer: (address: string | undefined) => void = () => {}
  ) {}

  /** Whether the listener is currently accepting connections. */
  get listening(): boolean {
    return this.server !== null
  }

  /** The port in use, or null when stopped. */
  get port(): number | null {
    const address = this.server?.address()
    return address && typeof address === 'object' ? address.port : null
  }

  /**
   * Start listening.
   *
   * Binds to every interface deliberately: the phone is on the LAN, so binding to
   * loopback would make the feature useless. "LAN only" is about not building a
   * relay — off-network access is the user's own Tailscale or tunnel, and Anodex
   * never carries their traffic (§7.1.3).
   */
  async start(port = 0, host = '0.0.0.0'): Promise<number> {
    if (this.server) return this.port ?? port

    const server = createServer({
      cert: this.certificate.certPem,
      key: this.certificate.privateKeyPem,
      minVersion: 'TLSv1.2'
    })

    const sockets = new WebSocketServer({ server, maxPayload: MAX_FRAME_BYTES })
    sockets.on('connection', (socket, request) =>
      this.onConnection(socket, request.socket.remoteAddress)
    )

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      // Bound explicitly to every IPv4 interface. Node's default binds `::`, and on
      // a machine with IPv6 disabled or filtered that can end up unreachable from a
      // phone on the same Wi-Fi — a failure that looks exactly like a wrong port.
      server.listen(port, host, () => {
        server.off('error', reject)
        resolve()
      })
    })

    this.server = server
    this.sockets = sockets
    log.info(
      `listening on port ${this.port} (fingerprint ${this.certificate.sha256.slice(0, 16)}…)`
    )
    return this.port ?? port
  }

  /** Stop listening and drop every client. */
  async stop(): Promise<void> {
    const server = this.server
    const sockets = this.sockets
    this.server = null
    this.sockets = null
    detachAllRemoteClients()

    if (sockets) {
      for (const socket of sockets.clients) socket.terminate()
      await new Promise<void>((resolve) => sockets.close(() => resolve()))
    }
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    log.info('stopped')
  }

  private onConnection(socket: WebSocket, peerAddress: string | undefined): void {
    let client: ClientChannel | null = null

    // An unauthenticated socket is a stranger holding a connection open. Give it
    // exactly long enough to say who it is.
    const handshakeTimer = setTimeout(() => {
      if (!client) {
        this.refuse(socket, 'handshake-timeout', 'No hello received.')
        socket.close()
      }
    }, HANDSHAKE_TIMEOUT_MS)

    socket.on('message', (raw) => {
      const parsed = parseClientFrame(raw as Buffer)
      if (!parsed.ok) {
        this.refuse(socket, parsed.code, parsed.message)
        return
      }

      const frame = parsed.frame
      if (frame.type === 'ping') {
        this.send(socket, { type: 'pong' })
        return
      }

      // Nothing but the two handshake frames is accepted until authenticated.
      if (!client) {
        if (frame.type === 'hello' || frame.type === 'pair') {
          if (!versionsCompatible(frame.protocolVersion, PROTOCOL_VERSION)) {
            this.refuse(
              socket,
              'protocol-mismatch',
              `Anodex on this PC speaks protocol ${PROTOCOL_VERSION}; your phone app speaks ` +
                `${frame.protocolVersion}. Update the app.`
            )
            socket.close()
            return
          }
        }

        if (frame.type === 'hello') {
          const auth = this.pairing.authenticate(frame.deviceKey)
          if (!auth.ok) {
            this.refuse(socket, auth.failure.reason, auth.failure.message)
            socket.close()
            return
          }
          clearTimeout(handshakeTimer)
          client = this.attach(socket, auth.device.deviceId, peerAddress)
          this.send(socket, {
            type: 'welcome',
            deviceId: auth.device.deviceId,
            protocolVersion: PROTOCOL_VERSION,
            addresses: this.reachableAddresses()
          })
          return
        }

        if (frame.type === 'pair') {
          const outcome = this.pairing.completePairing(frame.secret, frame.deviceName ?? 'Phone')
          if (!outcome.ok) {
            this.refuse(socket, outcome.failure.reason, outcome.failure.message)
            socket.close()
            return
          }
          clearTimeout(handshakeTimer)
          client = this.attach(socket, outcome.device.deviceId, peerAddress)
          this.send(socket, {
            type: 'paired',
            deviceKey: outcome.deviceKey,
            deviceId: outcome.device.deviceId,
            protocolVersion: PROTOCOL_VERSION,
            // Sent at pairing as well as at every reconnect, so a phone paired on
            // the LAN already knows every other route before it first leaves home.
            addresses: this.reachableAddresses()
          })
          return
        }

        this.refuse(socket, 'not-authenticated', 'Say hello first.')
        socket.close()
        return
      }

      if (frame.type === 'invoke') {
        void this.dispatch(socket, client, frame.id, frame.channel, frame.args)
      }
    })

    socket.on('close', () => {
      clearTimeout(handshakeTimer)
      if (client) detachRemoteClient(client)
    })

    socket.on('error', (error) => {
      log.warn('socket error:', error)
    })
  }

  /**
   * Every address this machine can be reached at, best first.
   *
   * The public one goes last: it is the slowest route and the only one that leaves
   * the house, so the phone should exhaust the LAN and any VPN before using it.
   */
  private reachableAddresses(): string[] {
    const local = collectHostAddresses().map((entry) => entry.address)
    const external = this.externalAddress()
    return external && !local.includes(external) ? [...local, external] : local
  }

  private attach(socket: WebSocket, deviceId: string, peerAddress?: string): ClientChannel {
    // Reported only for a socket that authenticated. An unauthenticated stranger
    // arriving from the internet is a port scanner, not proof the user's own phone
    // can get in — and reporting it would claim the setup works when it may not.
    this.onPeer(peerAddress)

    const client: ClientChannel = {
      id: `remote:${deviceId}`,
      send: (channel, payload) => {
        this.send(socket, { type: 'event', channel, payload, seq: ++this.sequence })
      },
      isAlive: () => socket.readyState === socket.OPEN
    }
    attachRemoteClient(client)
    log.info(`client attached: ${client.id}`)
    return client
  }

  /**
   * Run one call against the handler the renderer would have reached.
   *
   * The handler is given an event carrying this connection's `ClientChannel` under
   * `REMOTE_CLIENT`. Most handlers take `(_event, …)` and ignore it, which is what
   * makes generic re-dispatch possible — but the ones that stream, chat above all,
   * need somewhere to send tokens back to.
   *
   * An earlier version passed `undefined` on the reasoning that every handler
   * touching `event.sender` was one the policy refused. That was simply wrong:
   * `chat:send` is allowed and streams through `event.sender`, so the first real
   * message from a phone failed with a TypeError — after a successful handshake,
   * so everything looked connected until the moment it was used.
   */
  private async dispatch(
    socket: WebSocket,
    client: ClientChannel,
    id: string,
    channel: string,
    args: unknown[]
  ): Promise<void> {
    const decision = decideRemoteChannel(channel)
    if (!decision.allowed) {
      this.fail(socket, id, decision.reason, decision.message)
      return
    }

    const handler = this.lookup(channel)
    if (!handler) {
      this.fail(socket, id, 'unknown-channel', `This version of Anodex has no "${channel}".`)
      return
    }

    try {
      const result = await handler({ [REMOTE_CLIENT]: client }, ...args)
      this.send(socket, { type: 'result', id, ok: true, result })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.warn(`remote ${channel} failed:`, error)
      this.fail(socket, id, 'handler-failed', message)
    }
  }

  private send(socket: WebSocket, frame: ServerFrame): void {
    if (socket.readyState !== socket.OPEN) return
    try {
      socket.send(JSON.stringify(frame))
    } catch (error) {
      log.warn('send failed:', error)
    }
  }

  private fail(socket: WebSocket, id: string, code: string, message: string): void {
    this.send(socket, { type: 'result', id, ok: false, error: { code, message } })
  }

  private refuse(socket: WebSocket, code: string, message: string): void {
    this.send(socket, { type: 'refused', code, message })
  }
}
