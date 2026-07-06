import { convert } from 'html-to-text'
import type { ToolFactory } from './types'
import { runReadTool } from './helpers'

const FETCH_TIMEOUT_MS = 30_000

/**
 * fetch_url — read a public web page and return its text content.
 *
 * This is a read-only web tool: the assistant can fetch URLs it already knows
 * about (e.g. documentation, release notes, package readmes) but cannot perform
 * an open-ended web search without a search API key.
 *
 * Only public `http`/`https` addresses are allowed — requests to loopback and
 * private/link-local hosts are refused, both for the initial URL and the final
 * URL after any redirects, so the tool can't be steered into reading local
 * services.
 */
export const fetchUrlTool: ToolFactory = (define, ctx) =>
  define({
    description:
      'Fetch a public URL and return its readable text content. Use for documentation, release notes, or known web pages.',
    params: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The full public http(s) URL to fetch.' }
      },
      required: ['url']
    } as const,
    handler: (args: { url: string }) =>
      runReadTool(ctx, {
        name: 'fetch_url',
        kind: 'web',
        title: `Fetch ${truncate(args.url, 60)}`,
        async run() {
          const response = await fetchUrl(args.url, ctx.signal)
          const text = convert(response, {
            selectors: [
              { selector: 'a', options: { ignoreHref: true } },
              { selector: 'img', format: 'skip' }
            ]
          })
          const trimmed = text.trim()
          // No truncation here: `runReadTool`'s own MAX_MODEL_RESULT_CHARS cap
          // already applies uniformly to every read tool's result (same
          // reasoning as the read_file/run_command/git_diff/web_search
          // fixes — this tool's own, much larger, redundant cap never
          // actually changed the truncation point, it just produced a
          // misleading note when both fired).
          return {
            modelResult: trimmed || '(no readable text)',
            detail: `${trimmed.length} chars`
          }
        }
      })
  })

/**
 * Fetch a URL with a timeout and abort support. Redirects are followed by
 * `fetch` (which also handles gzip/charset); we validate the host before the
 * request and re-validate the final resolved URL so a redirect can't deliver
 * the contents of a private/loopback address to the model.
 */
async function fetchUrl(rawUrl: string, signal?: AbortSignal): Promise<string> {
  const start = assertPublicUrl(rawUrl)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  const onAbort = (): void => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const response = await fetch(start.toString(), {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Anodex/1.0' }
    })

    // Guard against redirects that land on a private/loopback host.
    if (response.url) assertPublicUrl(response.url)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }
    return await response.text()
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('The request timed out or was cancelled.')
    }
    throw error
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** Parse a URL and reject non-http(s) schemes and private/loopback hosts. */
function assertPublicUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`Invalid URL: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only http and https URLs are allowed (got "${url.protocol}").`)
  }
  if (isPrivateHost(url.hostname)) {
    throw new Error(`Refusing to fetch a local or private address (${url.hostname}).`)
  }
  return url
}

/** True for loopback, link-local, and private-range hosts. */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '0.0.0.0' || host === '::' || host === '::1') return true
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return true

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])]
    if (a === 127 || a === 10) return true // loopback, private
    if (a === 169 && b === 254) return true // link-local
    if (a === 172 && b >= 16 && b <= 31) return true // private
    if (a === 192 && b === 168) return true // private
  }
  return false
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}
