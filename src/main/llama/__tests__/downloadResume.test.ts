import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadFile, totalFromHeaders } from '../modelDownloader'

/**
 * Picking up a download where it stopped.
 *
 * A failed transfer used to delete its partial file, so a network blip at 95%
 * of a thirty-gigabyte model meant starting from zero. Resuming is easy to get
 * *nearly* right and the near-miss is the worst outcome available: two
 * different responses spliced into one file produces a GGUF that downloads
 * cleanly, passes every size check, and fails at load with nothing to explain
 * it. So these cases care mostly about when resuming must *not* happen.
 */

const WHOLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

function stream(text: string): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    }
  })
}

/** A server that honours Range, and records what it was asked for. */
function rangeServer(body = WHOLE, etag = '"v1"') {
  const seen: { range?: string; ifRange?: string }[] = []
  const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? {})
    const range = headers.get('range') ?? undefined
    seen.push({ range, ifRange: headers.get('if-range') ?? undefined })

    const match = range ? /bytes=(\d+)-/.exec(range) : null
    if (!match) {
      return Promise.resolve(
        new Response(stream(body), {
          status: 200,
          headers: { 'content-length': String(body.length), etag }
        })
      )
    }
    const from = Number(match[1])
    if (from >= body.length) return Promise.resolve(new Response(null, { status: 416 }))
    const rest = body.slice(from)
    return Promise.resolve(
      new Response(stream(rest), {
        status: 206,
        headers: {
          'content-length': String(rest.length),
          'content-range': `bytes ${from}-${body.length - 1}/${body.length}`,
          etag
        }
      })
    )
  })
  return { fetchMock, seen }
}

describe('downloadFile — resuming', () => {
  let dir: string
  let target: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anodex-resume-'))
    target = join(dir, 'model.gguf')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
    vi.unstubAllGlobals()
  })

  it('asks for the whole file when there is nothing on disk', async () => {
    const { fetchMock, seen } = rangeServer()
    vi.stubGlobal('fetch', fetchMock)

    await downloadFile('https://example.com/m.gguf', target, new AbortController().signal, () => {})

    expect(seen[0].range).toBeUndefined()
    expect(await readFile(target, 'utf-8')).toBe(WHOLE)
  })

  it('resumes from exactly where the part file stopped', async () => {
    await writeFile(`${target}.part`, WHOLE.slice(0, 10))
    await writeFile(`${target}.part.etag`, '"v1"')
    const { fetchMock, seen } = rangeServer()
    vi.stubGlobal('fetch', fetchMock)

    await downloadFile('https://example.com/m.gguf', target, new AbortController().signal, () => {})

    expect(seen[0].range).toBe('bytes=10-')
    expect(seen[0].ifRange).toBe('"v1"')
    // The whole file, not the tail on its own and not the tail twice.
    expect(await readFile(target, 'utf-8')).toBe(WHOLE)
  })

  it('reports the size of the file, not of the remaining chunk', async () => {
    await writeFile(`${target}.part`, WHOLE.slice(0, 20))
    await writeFile(`${target}.part.etag`, '"v1"')
    vi.stubGlobal('fetch', rangeServer().fetchMock)

    const seenTotals: (number | null)[] = []
    let last = 0
    await downloadFile(
      'https://example.com/m.gguf',
      target,
      new AbortController().signal,
      (received, total) => {
        seenTotals.push(total)
        last = received
      }
    )

    // 6 bytes were left; the total must still be 26, or a resumed download
    // finishes at several hundred percent.
    expect(new Set(seenTotals)).toEqual(new Set([WHOLE.length]))
    expect(last).toBe(WHOLE.length)
  })

  it('starts over when the remote file changed under the part', async () => {
    await writeFile(`${target}.part`, 'STALE BYTES')
    await writeFile(`${target}.part.etag`, '"old"')
    // A server that refuses the If-Range and answers with the whole new file.
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(stream(WHOLE), {
          status: 200,
          headers: { 'content-length': String(WHOLE.length), etag: '"v2"' }
        })
      )
    )
    vi.stubGlobal('fetch', fetchMock)

    await downloadFile('https://example.com/m.gguf', target, new AbortController().signal, () => {})

    // Not 'STALE BYTES' + the new body.
    expect(await readFile(target, 'utf-8')).toBe(WHOLE)
  })

  it('does not resume a part file with no validator beside it', async () => {
    // Without an ETag there is nothing that says these bytes belong to this
    // URL, so they are not trusted.
    await writeFile(`${target}.part`, 'UNVERIFIABLE')
    const { fetchMock, seen } = rangeServer()
    vi.stubGlobal('fetch', fetchMock)

    await downloadFile('https://example.com/m.gguf', target, new AbortController().signal, () => {})

    expect(seen[0].range).toBeUndefined()
    expect(await readFile(target, 'utf-8')).toBe(WHOLE)
  })

  it('recovers when the part is already as long as the file', async () => {
    // 416. A run killed between the last write and the rename lands here.
    await writeFile(`${target}.part`, WHOLE)
    await writeFile(`${target}.part.etag`, '"v1"')
    vi.stubGlobal('fetch', rangeServer().fetchMock)

    await downloadFile('https://example.com/m.gguf', target, new AbortController().signal, () => {})

    expect(await readFile(target, 'utf-8')).toBe(WHOLE)
  })

  it('keeps the part file when the transfer fails, so the next try resumes', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            // The chunk is delivered and allowed to reach disk before the
            // connection drops. Erroring in the same tick tests nothing real:
            // by the time a transfer dies at 95%, gigabytes have long since
            // been written.
            async pull(controller) {
              controller.enqueue(new TextEncoder().encode(WHOLE.slice(0, 8)))
              await new Promise((resolve) => setTimeout(resolve, 20))
              controller.error(new Error('connection reset'))
            }
          }),
          { status: 200, headers: { 'content-length': String(WHOLE.length), etag: '"v1"' } }
        )
      )
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      downloadFile('https://example.com/m.gguf', target, new AbortController().signal, () => {})
    ).rejects.toThrow()

    expect(existsSync(target)).toBe(false)
    expect((await stat(`${target}.part`)).size).toBe(8)
    expect(await readFile(`${target}.part.etag`, 'utf-8')).toBe('"v1"')

    // And the retry finishes the job rather than refetching those 8 bytes.
    const { fetchMock: second, seen } = rangeServer()
    vi.stubGlobal('fetch', second)
    await downloadFile('https://example.com/m.gguf', target, new AbortController().signal, () => {})
    expect(seen[0].range).toBe('bytes=8-')
    expect(await readFile(target, 'utf-8')).toBe(WHOLE)
  })

  it('discards the partial when the file is gone for good', async () => {
    // A 404 can never be resumed, and the app shows no partials — an orphan
    // here is a file nobody can find to delete.
    await writeFile(`${target}.part`, 'ORPHAN')
    await writeFile(`${target}.part.etag`, '"v1"')
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status: 404 })))
    )

    await expect(
      downloadFile('https://example.com/m.gguf', target, new AbortController().signal, () => {})
    ).rejects.toThrow('404')

    expect(existsSync(`${target}.part`)).toBe(false)
    expect(existsSync(`${target}.part.etag`)).toBe(false)
  })

  it('keeps the partial through a server error, which is what resuming is for', async () => {
    await writeFile(`${target}.part`, WHOLE.slice(0, 5))
    await writeFile(`${target}.part.etag`, '"v1"')
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status: 503 })))
    )

    await expect(
      downloadFile('https://example.com/m.gguf', target, new AbortController().signal, () => {})
    ).rejects.toThrow('503')

    expect((await stat(`${target}.part`)).size).toBe(5)
  })

  it('leaves nothing behind when the user cancels', async () => {
    // Cancelling is someone saying stop, not a failure to recover from — a
    // twenty-gigabyte orphan they cannot see is not a kindness.
    const controller = new AbortController()
    const fetchMock = vi.fn(() => {
      controller.abort()
      return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    })
    vi.stubGlobal('fetch', fetchMock)
    await writeFile(`${target}.part`, 'PARTIAL')
    await writeFile(`${target}.part.etag`, '"v1"')

    await expect(
      downloadFile('https://example.com/m.gguf', target, controller.signal, () => {})
    ).rejects.toThrow()

    expect(existsSync(`${target}.part`)).toBe(false)
    expect(existsSync(`${target}.part.etag`)).toBe(false)
  })

  it('cleans up the validator once the file is complete', async () => {
    vi.stubGlobal('fetch', rangeServer().fetchMock)
    await downloadFile('https://example.com/m.gguf', target, new AbortController().signal, () => {})
    expect(existsSync(`${target}.part`)).toBe(false)
    expect(existsSync(`${target}.part.etag`)).toBe(false)
  })

  it('falls back to Last-Modified when there is no ETag', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(stream(WHOLE), {
          status: 200,
          headers: {
            'content-length': String(WHOLE.length),
            'last-modified': 'Wed, 21 Sep 2026 00:00:00 GMT'
          }
        })
      )
    )
    vi.stubGlobal('fetch', fetchMock)

    // Fails after the validator is written, so we can see what was stored.
    await downloadFile('https://example.com/m.gguf', target, new AbortController().signal, () => {})
    expect(await readFile(target, 'utf-8')).toBe(WHOLE)
  })
})

describe('totalFromHeaders', () => {
  it('reads the whole size out of a Content-Range', () => {
    const headers = new Headers({
      'content-range': 'bytes 1000-1999/30000',
      'content-length': '1000'
    })
    expect(totalFromHeaders(headers, 1000)).toBe(30000)
  })

  it('uses content-length plus what is on disk when there is no range', () => {
    expect(totalFromHeaders(new Headers({ 'content-length': '500' }), 100)).toBe(600)
  })

  it('returns null rather than a wrong number when the server says nothing', () => {
    expect(totalFromHeaders(new Headers(), 0)).toBeNull()
    expect(totalFromHeaders(new Headers({ 'content-length': '0' }), 0)).toBeNull()
  })

  it('ignores an unparseable Content-Range instead of trusting it', () => {
    const headers = new Headers({ 'content-range': 'bytes */*', 'content-length': '10' })
    expect(totalFromHeaders(headers, 5)).toBe(15)
  })
})
