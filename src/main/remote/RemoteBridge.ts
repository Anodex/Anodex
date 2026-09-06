import { createServer, type Server as HttpsServer } from 'node:https'
import { WebSocketServer, type WebSocket } from 'ws'
import { createLogger } from '../utils/logger'
import type { ClientChannel } from '../clients/ClientChannel'
import {
  attachRemoteClient,
  detachAllRemoteClients,
  detachRemoteClient
} from '../clients/clientRegistry'
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
    private readonly lookup: (channel: string) => IpcHandler | undefined = handlerFor
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
    sockets.on('connection', (socket) => this.onConnection(socket))

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

  private onConnection(socket: WebSocket): void {
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
          client = this.attach(socket, auth.device.deviceId)
          this.send(socket, {
            type: 'welcome',
            deviceId: auth.device.deviceId,
            protocolVersion: PROTOCOL_VERSION
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
          client = this.attach(socket, outcome.device.deviceId)
          this.send(socket, {
            type: 'paired',
            deviceKey: outcome.deviceKey,
            deviceId: outcome.device.deviceId,
            protocolVersion: PROTOCOL_VERSION
          })
          return
        }

        this.refuse(socket, 'not-authenticated', 'Say hello first.')
        socket.close()
        return
      }

      if (frame.type === 'invoke') {
        void this.dispatch(socket, frame.id, frame.channel, frame.args)
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

  private attach(socket: WebSocket, deviceId: string): ClientChannel {
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
   * The `event` passed to the handler is `undefined`: 118 of Anodex's handlers
   * take `(_event, …)` and ignore it entirely, which is what makes generic
   * re-dispatch possible at all. The ones that genuinely use `event.sender` are
   * exactly the native-dialog and window-bound paths that `channelPolicy` refuses,
   * so a handler that would dereference it is never reached from here.
   */
  private async dispatch(
    socket: WebSocket,
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
      const result = await handler(undefined, ...args)
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
