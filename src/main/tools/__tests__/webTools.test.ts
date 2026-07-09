import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchUrlTool, setResolveHostForTests } from '../webTools'
import { createMockContext, createMockDefine } from './test-helpers'

describe('AI web tools', () => {
  beforeEach(() => {
    setResolveHostForTests(() => Promise.resolve(['93.184.216.34']))
  })

  afterEach(() => {
    setResolveHostForTests(null)
  })

  describe('fetch_url', () => {
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
      const tool = fetchUrlTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { url: string }) => Promise<string>
      }
      const result = await tool.handler({ url: 'https://example.com/docs' })

      expect(result.toLowerCase()).toContain('hello')
      expect(result).toContain('World')
    })

    it('truncates a very large page and reports the real total size', async () => {
      // Far more than the shared 4000-char model-result cap. Guards against
      // the same double-truncation bug found and fixed in
      // read_file/run_command/git_diff/web_search: this tool used to also
      // cap at its own, larger, redundant 100,000-char threshold, which the
      // outer cap always overrode anyway while reporting a meaningless
      // intermediate length instead of the page's real text size.
      const paragraphs = Array.from({ length: 5000 }, (_, i) => `<p>paragraph ${i}</p>`).join('')
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Map(),
        text: () => Promise.resolve(`<html><body>${paragraphs}</body></html>`)
      })

      const ctx = createMockContext('/tmp/workspace')
      const tool = fetchUrlTool(createMockDefine(), ctx) as unknown as {
        handler: (args: { url: string }) => Promise<string>
      }
      const result = await tool.handler({ url: 'https://example.com/huge' })

      expect(result.length).toBeLessThan(4100)
      expect(result).toMatch(/truncated, \d+ bytes total/)
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
        'http://192.168.1.1/'
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
  })
})
