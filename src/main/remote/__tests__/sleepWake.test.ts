import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * What happens to remote access when the computer sleeps and wakes.
 *
 * Sleep is the most common reason a desktop stops answering. The listener used to
 * be closed on suspend and never reopened, so a phone could not reconnect after the
 * first sleep until Anodex was restarted — exactly the "worked until it did not"
 * shape that is discovered days later, from somewhere the user cannot fix it.
 */

const paths = new Map<string, string>()
const calls = { starts: 0, stops: 0, goodbyes: [] as string[], mapped: [] as number[] }

vi.mock('electron', () => ({
  app: { getPath: (name: string) => paths.get(name) ?? tmpdir() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

vi.mock('../natpmp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../natpmp')>()),
  requestPortMapping: vi.fn((port: number) => {
    calls.mapped.push(port)
    return Promise.resolve({
      ok: true as const,
      mapping: {
        externalAddress: '203.0.113.7',
        externalPort: port,
        internalPort: port,
        lifetimeSeconds: 3600
      }
    })
  }),
  releasePortMapping: vi.fn(() => Promise.resolve(undefined))
}))

vi.mock('../RemoteBridge', () => ({
  PROTOCOL_VERSION: '1.0.0',
  RemoteBridge: class {
    listening = false
    port: number | null = null
    start(port: number): Promise<number> {
      calls.starts += 1
      this.listening = true
      this.port = port
      return Promise.resolve(port)
    }
    stop(): Promise<void> {
      calls.stops += 1
      this.listening = false
      this.port = null
      return Promise.resolve()
    }
    goodbye(farewell: string): Promise<void> {
      calls.goodbyes.push(farewell)
      return Promise.resolve()
    }
  }
}))

vi.mock('../certificate', () => ({
  generateRemoteCertificate: () =>
    Promise.resolve({ certPem: 'cert', privateKeyPem: 'key', sha256: 'ff'.repeat(32) })
}))

describe('remote access across sleep', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'anodex-remote-sleep-'))
    paths.set('userData', directory)
    calls.starts = 0
    calls.stops = 0
    calls.goodbyes.length = 0
    calls.mapped.length = 0
    vi.resetModules()
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  async function startedService(state: Record<string, unknown>) {
    writeFileSync(join(directory, 'remote.json'), JSON.stringify(state), 'utf-8')
    const { remoteService } = await import('../RemoteService')
    await remoteService.initialize()
    return remoteService
  }

  it('says goodbye on sleep but keeps listening, so the phone can come back', async () => {
    const service = await startedService({ enabled: true, port: 47800 })

    await service.sleeping()

    expect(calls.goodbyes).toEqual(['sleeping'])
    expect(calls.stops, 'the listener was closed for sleep').toBe(0)
    expect(service.status().listening).toBe(true)
  })

  it('asks the router again on waking, since the mapping or address may have changed', async () => {
    const service = await startedService({ enabled: true, internetEnabled: true, port: 47800 })
    calls.mapped.length = 0

    await service.sleeping()
    await service.woke()

    expect(calls.mapped).toEqual([47800])
    expect(service.externalAddress()).toBe('203.0.113.7')
  })

  it('does nothing on waking when remote access is off', async () => {
    const service = await startedService({ enabled: false })
    await service.woke()
    expect(calls.starts).toBe(0)
  })
})

describe('a damaged remote.json', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'anodex-remote-damaged-'))
    paths.set('userData', directory)
    vi.resetModules()
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('is kept aside before a clean state can overwrite the identity in it', async () => {
    writeFileSync(join(directory, 'remote.json'), '{"enabled": true, "certPem": "cert', 'utf-8')
    const { remoteService } = await import('../RemoteService')
    await remoteService.initialize()
    await remoteService.setEnabled(false)

    const kept = readdirSync(directory).filter((name) => name.startsWith('remote.json.unreadable-'))
    expect(kept).toHaveLength(1)
    expect(existsSync(join(directory, 'remote.json'))).toBe(true)
  })
})
