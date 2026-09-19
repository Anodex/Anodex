import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { generateRemoteCertificate, type RemoteCertificate } from '../../remote/certificate'
import { PairingService, type PairedDevice, type PairedDeviceStore } from '../../remote/pairing'
import { PROTOCOL_VERSION, RemoteBridge } from '../../remote/RemoteBridge'
import { detachAllRemoteClients } from '../../clients/clientRegistry'
import type { ServerFrame } from '../../remote/protocol'
import { encodeControl, encodeVoiceFrame, parseVoiceFrame, VoiceFrameKind } from '../voiceFrames'
import { VOICE_CAPABILITY } from '../voiceCapability'

/**
 * Stage 1: audio goes out, the same audio comes back.
 *
 * The point of the echo is the measurement — what a real phone over a real network
 * costs, before any model exists to blame. This test cannot measure that; what it
 * can do is pin the properties the measurement depends on, so that the number the
 * phone reports is a number about the network:
 *
 *   - the header comes back untouched, or the phone is timing this code's clock
 *   - audio never reaches the JSON parser
 *   - a client that did not announce voice cannot open the path at all
 *
 * See `docs/HANDOFF_VOICE.md` §10.
 */
describe('the voice loop', () => {
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
    process.env.ANODEX_VOICE = '1'
    stored = []
    detachAllRemoteClients()
    pairing = new PairingService(store)
    bridge = new RemoteBridge(pairing, certificate, () => undefined)
    port = await bridge.start(0)
  })

  afterEach(async () => {
    delete process.env.ANODEX_VOICE
    await bridge.stop()
    detachAllRemoteClients()
  })

  async function paired(capabilities: string[]): Promise<WebSocket> {
    const socket = new WebSocket(`wss://127.0.0.1:${port}`, { ca: [certificate.certPem] })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })
    const session = pairing.beginPairing()
    socket.send(
      JSON.stringify({
        type: 'pair',
        protocolVersion: PROTOCOL_VERSION,
        secret: session.secret,
        capabilities
      })
    )
    await nextText(socket)
    return socket
  }

  function nextText(socket: WebSocket): Promise<ServerFrame> {
    return new Promise((resolve, reject) => {
      socket.once('message', (raw: Buffer) =>
        resolve(JSON.parse(raw.toString('utf8')) as ServerFrame)
      )
      socket.once('error', reject)
    })
  }

  function nextBinary(socket: WebSocket, withinMs = 2000): Promise<Buffer | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), withinMs)
      socket.on('message', (raw: Buffer, isBinary: boolean) => {
        if (!isBinary) return
        clearTimeout(timer)
        resolve(raw)
      })
    })
  }

  it('sends back exactly what it was given', async () => {
    const socket = await paired([VOICE_CAPABILITY])
    // Twenty milliseconds of 24 kHz 16-bit mono, which is what the phone sends.
    const audio = Buffer.alloc(960)
    for (let i = 0; i < audio.length; i += 1) audio[i] = i % 251

    socket.send(
      encodeVoiceFrame({ kind: VoiceFrameKind.Audio, seq: 42, atMs: 987_654, payload: audio }),
      { binary: true }
    )

    const raw = await nextBinary(socket)
    expect(raw).not.toBeNull()
    const parsed = parseVoiceFrame(raw as Buffer)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    // The header is the measurement. If either of these is rewritten, the phone's
    // round-trip number becomes a number about this machine.
    expect(parsed.frame.seq).toBe(42)
    expect(parsed.frame.atMs).toBe(987_654)
    expect(parsed.frame.payload).toEqual(audio)
    socket.close()
  })

  it('answers a start so the phone knows before it opens the microphone', async () => {
    const socket = await paired([VOICE_CAPABILITY])
    socket.send(encodeControl(1, 5, { type: 'start' }), { binary: true })

    const raw = await nextBinary(socket)
    expect(raw).not.toBeNull()
    const parsed = parseVoiceFrame(raw as Buffer)
    expect(parsed.ok && parsed.frame.kind).toBe(VoiceFrameKind.Control)
    expect(parsed.ok && JSON.parse(parsed.frame.payload.toString('utf8'))).toMatchObject({
      type: 'started'
    })
    socket.close()
  })

  it('ignores a client that never said it could do voice', async () => {
    // Not refused — answered with nothing. A phone sending audio it never
    // announced is confused or probing, and a reply per frame is its own
    // amplification.
    const socket = await paired([])
    socket.send(
      encodeVoiceFrame({
        kind: VoiceFrameKind.Audio,
        seq: 1,
        atMs: 1,
        payload: Buffer.alloc(16)
      }),
      { binary: true }
    )

    expect(await nextBinary(socket, 400)).toBeNull()
    socket.close()
  })

  it('ignores audio when this computer has voice switched off', async () => {
    const socket = await paired([VOICE_CAPABILITY])
    delete process.env.ANODEX_VOICE

    socket.send(
      encodeVoiceFrame({
        kind: VoiceFrameKind.Audio,
        seq: 1,
        atMs: 1,
        payload: Buffer.alloc(16)
      }),
      { binary: true }
    )

    expect(await nextBinary(socket, 400)).toBeNull()
    socket.close()
  })

  it('does not announce voice when it is switched off', async () => {
    delete process.env.ANODEX_VOICE
    const socket = new WebSocket(`wss://127.0.0.1:${port}`, { ca: [certificate.certPem] })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })
    const session = pairing.beginPairing()
    socket.send(
      JSON.stringify({ type: 'pair', protocolVersion: PROTOCOL_VERSION, secret: session.secret })
    )

    const frame = await nextText(socket)
    expect(frame.type === 'paired' && frame.capabilities).toEqual([])
    socket.close()
  })

  it('leaves the text side of the connection working', async () => {
    // The seam is one branch on the message handler. If it were wrong, every
    // ordinary call on the socket would be the casualty — which is the reason
    // this test exists rather than a review comment.
    const socket = await paired([VOICE_CAPABILITY])
    socket.send(
      encodeVoiceFrame({
        kind: VoiceFrameKind.Audio,
        seq: 1,
        atMs: 1,
        payload: Buffer.alloc(16)
      }),
      { binary: true }
    )
    await nextBinary(socket)

    socket.send(JSON.stringify({ type: 'ping' }))
    const frame = await new Promise<ServerFrame>((resolve) => {
      socket.on('message', (raw: Buffer, isBinary: boolean) => {
        if (isBinary) return
        resolve(JSON.parse(raw.toString('utf8')) as ServerFrame)
      })
    })

    expect(frame.type).toBe('pong')
    socket.close()
  })

  it('drops audio arriving faster than any microphone produces it', async () => {
    // Audio is fifty frames a second. An authenticated client is still a client,
    // and without a ceiling it can make the desktop echo at whatever rate it likes.
    const socket = await paired([VOICE_CAPABILITY])
    const received: Buffer[] = []
    socket.on('message', (raw: Buffer, isBinary: boolean) => {
      if (isBinary) received.push(raw)
    })

    for (let i = 0; i < 400; i += 1) {
      socket.send(
        encodeVoiceFrame({
          kind: VoiceFrameKind.Audio,
          seq: i,
          atMs: i,
          payload: Buffer.alloc(8)
        }),
        { binary: true }
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 600))

    expect(received.length).toBeGreaterThan(0)
    expect(received.length).toBeLessThan(400)
    socket.close()
  })
})
