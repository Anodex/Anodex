import { lookup } from 'node:dns/promises'
import { convert } from 'html-to-text'
import { Agent } from 'undici'
import type { ToolFactory } from './types'
import { runReadTool } from './helpers'

const FETCH_TIMEOUT_MS = 30_000

let resolveHost = async (hostname: string): Promise<string[]> => {
  const records = await lookup(hostname, { all: true, verbatim: true })
  return records.map((record) => record.address)
}

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

const MAX_REDIRECTS = 10
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/**
 * Fetch a URL with a timeout and abort support, following redirects manually
 * (one hop at a time) so every hop — not just the final URL — gets its own
 * DNS re-validation.
 *
 * DNS is resolved once per hop via `assertPublicDns`, and the resulting
 * address is pinned into a per-hop `undici.Agent` so the actual TCP
 * connection is forced to the exact IP we validated. Letting `fetch` re-run
 * its own DNS lookup after our check would open a DNS-rebinding gap: a
 * malicious resolver could answer the pre-check with a public IP and the
 * real connection with a private/loopback one.
 */
async function fetchUrl(rawUrl: string, signal?: AbortSignal): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  const onAbort = (): void => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    let current = assertPublicUrl(rawUrl)
    for (let hop = 0; ; hop++) {
      if (hop > MAX_REDIRECTS) {
        throw new Error('Too many redirects.')
      }
      const addresses = await assertPublicDns(current)
      const dispatcher = pinnedDispatcher(addresses)
      try {
        const response = await fetch(current.toString(), {
          signal: controller.signal,
          redirect: 'manual',
          // Pins this request's connection to the pre-validated address
          // (see `pinnedDispatcher`) instead of trusting `fetch`'s own
          // internal DNS resolution.
          dispatcher,
          headers: { 'User-Agent': 'Anodex/1.0' }
        })

        if (REDIRECT_STATUSES.has(response.status)) {
          const location = response.headers.get('location')
          if (!location) {
            throw new Error(`HTTP ${response.status} redirect with no Location header.`)
          }
          current = assertPublicUrl(new URL(location, current).toString())
          continue
        }
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`)
        }
        return await response.text()
      } finally {
        await dispatcher.close()
      }
    }
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

/** An undici dispatcher whose connections are pinned to pre-validated addresses. */
function pinnedDispatcher(addresses: string[]): Agent {
  const records = addresses.map((address) => ({
    address,
    family: address.includes(':') ? 6 : 4
  }))
  return new Agent({
    connect: {
      // Node's connector calls this either "all" style (Happy Eyeballs,
      // expects an array) or single-address style depending on runtime
      // settings — support both so the pin holds either way.
      lookup: (_hostname, options, callback) => {
        if (options && (options as { all?: boolean }).all) {
          callback(null, records)
        } else {
          callback(null, records[0].address, records[0].family)
        }
      }
    }
  })
}

export function setResolveHostForTests(
  resolver: ((hostname: string) => Promise<string[]>) | null
): void {
  resolveHost = resolver
    ? resolver
    : async (hostname: string): Promise<string[]> => {
        const records = await lookup(hostname, { all: true, verbatim: true })
        return records.map((record) => record.address)
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

/**
 * Resolve public-looking hostnames and reject DNS answers that point inward.
 * Returns the validated addresses so the caller can pin the actual
 * connection to them (see `pinnedDispatcher`) instead of trusting a second,
 * separate resolution.
 */
async function assertPublicDns(url: URL): Promise<string[]> {
  const addresses = await resolveHost(url.hostname)
  if (addresses.length === 0) {
    throw new Error(`Could not resolve host (${url.hostname}).`)
  }
  if (addresses.some(isPrivateAddress)) {
    throw new Error(`Refusing to fetch a local or private address (${url.hostname}).`)
  }
  return addresses
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

function isPrivateAddress(address: string): boolean {
  return isPrivateHost(address)
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}
