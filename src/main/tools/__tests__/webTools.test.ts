import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolArtifact } from '@shared/toolArtifacts.types'
import {
  extractFocusedPassages,
  fetchUrlEvidence,
  fetchUrlTool,
  looksLikeBoilerplatePassage,
  setResolveHostForTests
} from '../webTools'
import { WebSourceRegistry } from '../WebSourceRegistry'
import { createMockContext, createMockDefine } from './test-helpers'

describe('AI web tools', () => {
  beforeEach(() => {
    setResolveHostForTests(() => Promise.resolve(['93.184.216.34']))
  })

  afterEach(() => {
    setResolveHostForTests(null)
  })

  describe('fetch_url', () => {
    it('keeps a relevant passage near the end of a large page', () => {
      const text = `${'Unrelated introduction.\n\n'.repeat(300)}The Denver result was 42 percent in 2026.`
      const passages = extractFocusedPassages(text, 'Denver result 2026')

      expect(passages[0].text).toContain('Denver result was 42 percent')
    })

    it('drops navigation/menu boilerplate but keeps a real bulleted list of sentences', () => {
      // The live junk: a shop's flattened nav menu that verified as "evidence".
      const navMenu =
        'Body care * Sorted by use * Massage oils and massage balsams * Soaps * ' +
        'Foot care * Hand care * Body lotion * Shower creams * Hair care * For kids * ' +
        'For men * Royal jelly * Honey * Propolis * Beeswax'
      const firstAidList =
        '* Try to remove the stinger from the skin if it is still present. ' +
        'To do this, scrape a blunt edge across it. Do not squeeze the venom sac. ' +
        'Wash the area with soap and water, then apply a cold pack to reduce swelling.'

      expect(looksLikeBoilerplatePassage(navMenu)).toBe(true)
      expect(looksLikeBoilerplatePassage(firstAidList)).toBe(false)

      const passages = extractFocusedPassages(
        `${navMenu}\n\n${firstAidList}`,
        'bee sting first aid'
      )
      expect(passages.some((passage) => passage.text.includes('Massage oils'))).toBe(false)
      expect(passages.some((passage) => passage.text.includes('remove the stinger'))).toBe(true)
    })

    it('fetches a URL and returns readable text', async () => {
      const html = '<html><body><h1>Hello</h1><p>World</p></body></html>'
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Map(),
        text: () => Promise.resolve(html)
      })

      const ctx = createMockContext('/tmp/workspace')
      const artifacts: unknown[] = []
      ctx.recordArtifact = (artifact) => artifacts.push(artifact)
      const tool = fetchUrlTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { url: string }) => Promise<string>
      }
      const result = await tool.handler({ url: 'https://example.com/docs' })

      expect(result.toLowerCase()).toContain('hello')
      expect(result).toContain('World')
      expect(artifacts).toHaveLength(1)
      expect(artifacts[0]).toMatchObject({
        kind: 'web-fetch',
        requestedUrl: 'https://example.com/docs',
        finalUrl: 'https://example.com/docs',
        status: 200
      })
    })

    it('registers a fetched page as verified and hands the model its id', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Map(),
        text: () =>
          Promise.resolve(
            '<html><head><title>Real title</title></head><body><p>' +
              'A paragraph with enough substance to survive passage extraction and be kept.' +
              '</p></body></html>'
          )
      })

      const ctx = createMockContext('/tmp/workspace')
      const registry = new WebSourceRegistry()
      ctx.webSources = registry
      const tool = fetchUrlTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { url: string }) => Promise<string>
      }
      const result = await tool.handler({ url: 'https://example.com/page' })

      expect(result).toContain('Cite as [S1]')
      const [source] = registry.list()
      expect(source).toMatchObject({ id: 'S1', url: 'https://example.com/page', verified: true })
    })

    it('does not call a page verified when it yields no readable passages', async () => {
      // A 200 that extracts to nothing is no better evidence than a search
      // hit, and marking it verified would be the exact overclaim to avoid.
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Map(),
        text: () => Promise.resolve('<html><body></body></html>')
      })

      const ctx = createMockContext('/tmp/workspace')
      const registry = new WebSourceRegistry()
      ctx.webSources = registry
      const tool = fetchUrlTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { url: string }) => Promise<string>
      }
      await tool.handler({ url: 'https://example.com/empty' })

      expect(registry.attempted).toBe(true)
      expect(registry.hasVerified()).toBe(false)
    })

    it('does not start a request when direct evidence fetching is already cancelled', async () => {
      const fetchSpy = vi.fn()
      globalThis.fetch = fetchSpy
      const controller = new AbortController()
      controller.abort()

      await expect(
        fetchUrlEvidence('https://example.com/docs', 'documentation', controller.signal)
      ).rejects.toThrow('timed out or was cancelled')
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('cancels while DNS resolution is stalled', async () => {
      const fetchSpy = vi.fn()
      globalThis.fetch = fetchSpy
      setResolveHostForTests(() => new Promise<string[]>(() => undefined))
      const controller = new AbortController()

      const pending = fetchUrlEvidence(
        'https://stalled-dns.example/docs',
        'documentation',
        controller.signal
      )
      controller.abort()

      await expect(pending).rejects.toThrow('timed out or was cancelled')
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    /**
     * `dispatcher.close()` in `fetchUrl`'s `finally` waits for the request to
     * complete, and a response whose body was never read never completes.
     * Measured against a 302 carrying a 2 MB body: `close()` did not return at
     * all, while cancelling the body first closed it in 1 ms. The 30-second
     * fetch timeout does eventually abort and unblock it, so the symptom was
     * half a minute of dead wait followed by `The request timed out` for a page
     * whose redirect was perfectly fine.
     */
    describe('releases responses it never reads', () => {
      function bodyWithCancel(): { cancel: ReturnType<typeof vi.fn> } {
        return { cancel: vi.fn().mockResolvedValue(undefined) }
      }

      it('discards a redirect body before following the hop', async () => {
        const redirectBody = bodyWithCancel()
        globalThis.fetch = vi
          .fn()
          .mockResolvedValueOnce({
            status: 302,
            headers: new Map([['location', 'https://example.com/final']]),
            body: redirectBody
          })
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Map(),
            text: () => Promise.resolve('<html><body><p>Arrived.</p></body></html>')
          })

        const artifact = await fetchUrlEvidence('https://example.com/start', 'evidence')

        expect(redirectBody.cancel).toHaveBeenCalledTimes(1)
        expect(artifact.finalUrl).toBe('https://example.com/final')
      })

      it('discards an unsupported content type instead of leaving it open', async () => {
        // The likeliest one in ordinary use: a model follows a link to a PDF and
        // gets a large body nothing was ever going to parse.
        const pdfBody = bodyWithCancel()
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Map([['content-type', 'application/pdf']]),
          body: pdfBody
        })

        const artifact = await fetchUrlEvidence('https://example.com/paper.pdf', 'evidence')

        expect(pdfBody.cancel).toHaveBeenCalledTimes(1)
        expect(artifact.warnings.join(' ')).toContain('Unsupported content type')
      })

      it('discards an error response body before reporting the status', async () => {
        const errorBody = bodyWithCancel()
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 404,
          statusText: 'Not Found',
          headers: new Map(),
          body: errorBody
        })

        await expect(fetchUrlEvidence('https://example.com/gone', 'evidence')).rejects.toThrow(
          'HTTP 404'
        )
        expect(errorBody.cancel).toHaveBeenCalledTimes(1)
      })
    })

    it('bounds fetched page titles before persisting evidence metadata', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Map(),
        text: () =>
          Promise.resolve(`<html><title>${'Long title '.repeat(100)}</title><p>Evidence</p></html>`)
      })

      const artifact = await fetchUrlEvidence('https://example.com/long-title', 'evidence')

      expect(artifact.title.length).toBeLessThanOrEqual(300)
    })

    it('returns a bounded passage packet while retaining full artifact metadata', async () => {
      const paragraphs = Array.from({ length: 5000 }, (_, i) => `<p>paragraph ${i}</p>`).join('')
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Map(),
        text: () => Promise.resolve(`<html><body>${paragraphs}</body></html>`)
      })

      const ctx = createMockContext('/tmp/workspace')
      const artifacts: ToolArtifact[] = []
      ctx.recordArtifact = (artifact) => artifacts.push(artifact)
      const tool = fetchUrlTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { url: string }) => Promise<string>
      }
      const result = await tool.handler({ url: 'https://example.com/huge' })

      expect(result.length).toBeLessThan(4100)
      expect(result).toContain('[P1]')
      expect(artifacts[0]).toMatchObject({ kind: 'web-fetch' })
      if (artifacts[0].kind !== 'web-fetch') throw new Error('Expected a fetch artifact.')
      expect(artifacts[0].contentChars).toBeGreaterThan(50_000)
      expect(artifacts[0].passages).toHaveLength(8)
    })

    it('reports HTTP errors to the model', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: new Map(),
        text: () => Promise.resolve('not found')
      })

      const ctx = createMockContext('/tmp/workspace')
      const tool = fetchUrlTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { url: string }) => Promise<string>
      }
      const result = await tool.handler({ url: 'https://example.com/missing' })

      expect(result).toContain('404')
    })

    it('refuses loopback and private addresses (SSRF guard)', async () => {
      const fetchSpy = vi.fn()
      globalThis.fetch = fetchSpy

      const tool = fetchUrlTool(
        createMockDefine(),
        createMockContext('/tmp/workspace')
      ) as unknown as {
        handler: (args: { url: string }) => Promise<string>
      }

      for (const url of [
        'http://localhost:8080/',
        'http://127.0.0.1/',
        'http://169.254.169.254/latest/meta-data',
        'http://192.168.1.1/',
        'http://100.64.0.1/', // carrier-grade NAT (RFC 6598)
        'http://198.18.0.1/', // benchmark testing (RFC 2544)
        'http://192.0.2.1/', // documentation/special-use
        'http://224.0.0.1/', // multicast
        'http://240.0.0.1/', // reserved/future-use
        'http://0.0.0.1/', // "this network"
        'http://[::ffff:127.0.0.1]/', // IPv4-mapped IPv6 (dotted)
        'http://[::ffff:7f00:1]/', // IPv4-mapped IPv6 (hex)
        'http://[fe90::1]/', // IPv6 link-local (fe80::/10, not just fe80::/16)
        'http://[fec0::1]/', // deprecated IPv6 site-local range
        'http://[2001:db8::1]/', // IPv6 documentation range
        'http://[ff02::1]/' // IPv6 multicast
      ]) {
        const result = await tool.handler({ url })
        expect(result.toLowerCase()).toContain('local or private')
      }
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('refuses public-looking hostnames that resolve to private addresses', async () => {
      const fetchSpy = vi.fn()
      globalThis.fetch = fetchSpy
      setResolveHostForTests(() => Promise.resolve(['127.0.0.1']))

      const tool = fetchUrlTool(
        createMockDefine(),
        createMockContext('/tmp/workspace')
      ) as unknown as {
        handler: (args: { url: string }) => Promise<string>
      }
      const result = await tool.handler({ url: 'https://docs.example.test/page' })

      expect(result.toLowerCase()).toContain('local or private')
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it.each(['198.18.0.1', '192.0.2.1', 'fec0::1', '2001:db8::1'])(
      'refuses public-looking DNS names resolving to special-use address %s',
      async (address) => {
        const fetchSpy = vi.fn()
        globalThis.fetch = fetchSpy
        setResolveHostForTests(() => Promise.resolve([address]))

        await expect(
          fetchUrlEvidence('https://docs.example.test/page', 'documentation')
        ).rejects.toThrow('local or private')
        expect(fetchSpy).not.toHaveBeenCalled()
      }
    )

    it('re-validates DNS for a redirect that points at a private address', async () => {
      // Regression test for the DNS-rebinding TOCTOU fix: a redirect hop must
      // get its own resolveHost() check, not just the initial URL.
      let resolveCalls = 0
      setResolveHostForTests((hostname) => {
        resolveCalls += 1
        return Promise.resolve(hostname === 'evil.example.test' ? ['127.0.0.1'] : ['93.184.216.34'])
      })
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: false,
        status: 302,
        statusText: 'Found',
        headers: new Map([['location', 'https://evil.example.test/internal']]),
        text: () => Promise.resolve('')
      })
      globalThis.fetch = fetchSpy

      const tool = fetchUrlTool(
        createMockDefine(),
        createMockContext('/tmp/workspace')
      ) as unknown as {
        handler: (args: { url: string }) => Promise<string>
      }
      const result = await tool.handler({ url: 'https://docs.example.test/start' })

      expect(result.toLowerCase()).toContain('local or private')
      expect(resolveCalls).toBe(2) // initial hop + redirect hop
      expect(fetchSpy).toHaveBeenCalledTimes(1) // never followed the redirect
    })

    it('pins each fetch call to a dispatcher scoped to the validated addresses', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Map(),
        text: () => Promise.resolve('<p>hi</p>')
      })
      globalThis.fetch = fetchSpy

      const tool = fetchUrlTool(
        createMockDefine(),
        createMockContext('/tmp/workspace')
      ) as unknown as {
        handler: (args: { url: string }) => Promise<string>
      }
      await tool.handler({ url: 'https://example.com/docs' })

      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const init = fetchSpy.mock.calls[0][1] as { dispatcher?: unknown }
      expect(init.dispatcher).toBeDefined()
    })

    it('accepts a public IPv6 literal without performing a second DNS lookup', async () => {
      const resolver = vi.fn(() => Promise.reject(new Error('literal should not use DNS')))
      setResolveHostForTests(resolver)
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Map(),
        text: () => Promise.resolve('<p>public IPv6 evidence</p>')
      })

      const artifact = await fetchUrlEvidence(
        'https://[2606:4700:4700::1111]/docs',
        'IPv6 evidence'
      )

      expect(artifact.passages).not.toHaveLength(0)
      expect(resolver).not.toHaveBeenCalled()
    })

    it('refuses non-http(s) schemes', async () => {
      const fetchSpy = vi.fn()
      globalThis.fetch = fetchSpy

      const tool = fetchUrlTool(
        createMockDefine(),
        createMockContext('/tmp/workspace')
      ) as unknown as {
        handler: (args: { url: string }) => Promise<string>
      }
      const result = await tool.handler({ url: 'file:///etc/passwd' })

      expect(result).toContain('http and https')
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('refuses URLs containing embedded credentials', async () => {
      const fetchSpy = vi.fn()
      globalThis.fetch = fetchSpy

      await expect(
        fetchUrlEvidence('https://user:secret@example.com/docs', 'documentation')
      ).rejects.toThrow('embedded credentials')
      expect(fetchSpy).not.toHaveBeenCalled()
    })
  })
})
