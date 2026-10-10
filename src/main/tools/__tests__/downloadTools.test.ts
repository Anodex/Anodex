import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolCall, ToolConfirmRequest } from '@shared/tools.types'

const h = vi.hoisted(() => ({ free: null as number | null }))

// DNS is the one part that would need the network; a public answer stands in.
vi.mock('../webTools', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../webTools')>()),
  assertPublicDns: () => Promise.resolve(['93.184.216.34'])
}))
vi.mock('../../utils/diskSpace', () => ({ freeBytesAt: () => h.free }))

const { downloadFileTool, safeFileName } = await import('../downloadTools')
const { captureCalls, createMockContext, createMockDefine } = await import('./test-helpers')

const BODY = 'jar-bytes-here'

function stream(text: string): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    }
  })
}

let workspace: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'anodex-download-tool-'))
  h.free = null
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(workspace, { recursive: true, force: true })
})

function tool() {
  const confirmations: ToolConfirmRequest[] = []
  const { calls, emit } = captureCalls<ToolCall>()
  const ctx = {
    ...createMockContext(workspace),
    projectId: 'p1',
    emit,
    confirm: (request: ToolConfirmRequest) => {
      confirmations.push(request)
      return Promise.resolve({ approved: true })
    }
  }
  const fn = downloadFileTool(createMockDefine(), ctx) as unknown as {
    handler: (args: { url: string; path?: string }) => Promise<string>
  }
  return { fn, confirmations, calls }
}

function server(responses: Record<string, () => Response>) {
  const fetchMock = vi.fn((input: string | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`
    const make = responses[key]
    return make ? Promise.resolve(make()) : Promise.reject(new Error(`unexpected ${key}`))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('download_file', () => {
  it('says what, from where and how big before asking, then saves it', async () => {
    server({
      'HEAD https://example.com/server.jar': () =>
        new Response(null, { status: 200, headers: { 'content-length': String(BODY.length) } }),
      'GET https://example.com/server.jar': () =>
        new Response(stream(BODY), {
          status: 200,
          headers: { 'content-length': String(BODY.length), etag: '"1"' }
        })
    })
    const { fn, confirmations } = tool()

    const result = await fn.handler({ url: 'https://example.com/server.jar' })

    expect(confirmations).toHaveLength(1)
    expect(confirmations[0].detail).toBe(
      'Download server.jar (14 B) from example.com into server.jar'
    )
    expect(await readFile(join(workspace, 'server.jar'), 'utf-8')).toBe(BODY)
    expect(result).toContain('Downloaded server.jar')
  })

  it('refuses a local or private address before asking anything', async () => {
    const { fn, confirmations } = tool()
    const result = await fn.handler({ url: 'http://192.168.1.10/router-backup.bin' })
    expect(result).toMatch(/local or private address/)
    expect(confirmations).toHaveLength(0)
  })

  it('checks every redirect, so a link cannot bounce onto the local network', async () => {
    server({
      'HEAD https://example.com/latest': () =>
        new Response(null, { status: 302, headers: { location: 'http://10.0.0.5/admin' } })
    })
    const { fn, confirmations } = tool()
    const result = await fn.handler({ url: 'https://example.com/latest' })
    expect(result).toMatch(/local or private address/)
    expect(confirmations).toHaveLength(0)
  })

  it('keeps a server-supplied name inside the project folder', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd')
    expect(safeFileName('..\\..\\Windows\\evil.exe')).toBe('evil.exe')
    expect(safeFileName('report?.pdf')).toBe('report_.pdf')
  })

  it('refuses a file bigger than the disk has room for', async () => {
    h.free = 1024
    server({
      'HEAD https://example.com/big.iso': () =>
        new Response(null, { status: 200, headers: { 'content-length': String(4 * 1024 ** 3) } })
    })
    const { fn, confirmations } = tool()
    const result = await fn.handler({ url: 'https://example.com/big.iso' })
    expect(result).toMatch(/Free some space first/)
    expect(confirmations).toHaveLength(0)
  })
})
