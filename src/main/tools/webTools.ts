import { lookup } from 'node:dns/promises'
import { createHash } from 'node:crypto'
import { convert } from 'html-to-text'
import { Agent } from 'undici'
import type { EvidencePassage } from '@shared/toolArtifacts.types'
import type { ToolFactory } from './types'
import { recordToolArtifact } from './types'
import { runReadTool } from './helpers'

const FETCH_TIMEOUT_MS = 30_000
const MAX_FETCH_BYTES = 2_000_000
const MAX_PASSAGES = 8
const MAX_PASSAGE_CHARS = 900

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
        args,
        async run() {
          const response = await fetchUrl(args.url, ctx.signal)
          const text = convert(response.body, {
            selectors: [
              { selector: 'a', options: { ignoreHref: true } },
              { selector: 'img', format: 'skip' }
            ]
          })
          const trimmed = text.trim()
          const passages = extractFocusedPassages(trimmed, ctx.evidenceFocus ?? '')
          const title = extractHtmlTitle(response.body) || new URL(response.finalUrl).hostname
          const warnings = [...response.warnings]
          if (passages.length === 0) warnings.push('No readable evidence passages were extracted.')
          const artifact = recordToolArtifact(ctx, {
            kind: 'web-fetch',
            requestedUrl: args.url,
            finalUrl: response.finalUrl,
            status: response.status,
            contentType: response.contentType,
            title,
            contentHash: createHash('sha256').update(response.body).digest('hex'),
            contentChars: trimmed.length,
            truncated: response.truncated,
            passages,
            warnings
          })
          const passageText = passages
            .map((passage) => `[${passage.id}] ${passage.text}`)
            .join('\n\n')
          return {
            modelResult:
              `Source artifact: ${artifact.id}\nTitle: ${title}\nFinal URL: ${response.finalUrl}\n` +
              `HTTP ${response.status}; ${response.contentType}\n\n` +
              (passageText || '(no readable text)'),
            detail: `${trimmed.length} chars · ${passages.length} focused passages`
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
interface FetchedPage {
  body: string
  finalUrl: string
  status: number
  contentType: string
  truncated: boolean
  warnings: string[]
}

async function fetchUrl(rawUrl: string, signal?: AbortSignal): Promise<FetchedPage> {
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
        const contentType = response.headers.get('content-type')?.split(';')[0].trim() || 'unknown'
        if (!isReadableContentType(contentType)) {
          return {
            body: '',
            finalUrl: current.toString(),
            status: response.status,
            contentType,
            truncated: false,
            warnings: [`Unsupported content type: ${contentType}`]
          }
        }
        const body = await readResponseBody(response, MAX_FETCH_BYTES)
        return {
          body: body.text,
          finalUrl: current.toString(),
          status: response.status,
          contentType,
          truncated: body.truncated,
          warnings: body.truncated ? [`Response exceeded ${MAX_FETCH_BYTES} bytes.`] : []
        }
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

function isReadableContentType(contentType: string): boolean {
  return (
    contentType === 'unknown' ||
    contentType.startsWith('text/') ||
    contentType === 'application/xhtml+xml' ||
    contentType === 'application/json' ||
    contentType.endsWith('+json')
  )
}

async function readResponseBody(
  response: Response,
  maxBytes: number
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) {
    const text = await response.text()
    const encoded = new TextEncoder().encode(text)
    return encoded.byteLength > maxBytes
      ? { text: new TextDecoder().decode(encoded.subarray(0, maxBytes)), truncated: true }
      : { text, truncated: false }
  }
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  let truncated = false
  try {
    while (true) {
      const chunk = (await reader.read()) as { done: boolean; value?: Uint8Array }
      if (chunk.done || !chunk.value) break
      const value = chunk.value
      const remaining = maxBytes - bytes
      if (remaining <= 0) {
        truncated = true
        break
      }
      const kept = value.byteLength > remaining ? value.subarray(0, remaining) : value
      bytes += kept.byteLength
      text += decoder.decode(kept, { stream: true })
      if (kept.byteLength < value.byteLength) {
        truncated = true
        break
      }
    }
    text += decoder.decode()
  } finally {
    if (truncated) await reader.cancel()
    reader.releaseLock()
  }
  return { text, truncated }
}

export function extractFocusedPassages(text: string, focus: string): EvidencePassage[] {
  const normalized = text.replace(/\r/g, '').trim()
  if (!normalized) return []
  const terms = [...new Set(focus.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])].slice(0, 24)
  const chunks = normalized
    .split(/\n{2,}/)
    .flatMap((paragraph) => splitLongPassage(paragraph.trim(), MAX_PASSAGE_CHARS))
    .filter(Boolean)
  const ranked = chunks.map((passage, index) => {
    const lower = passage.toLowerCase()
    const termHits = terms.reduce((sum, term) => sum + countOccurrences(lower, term), 0)
    return { passage, index, score: termHits * 100 - index * 0.01 }
  })
  ranked.sort((a, b) => b.score - a.score || a.index - b.index)
  return ranked.slice(0, MAX_PASSAGES).map((item, index) => ({
    id: `P${index + 1}`,
    text: item.passage,
    score: Math.max(0, Math.round(item.score * 100) / 100)
  }))
}

function splitLongPassage(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return text ? [text] : []
  const passages: string[] = []
  for (let start = 0; start < text.length; start += maxChars) {
    passages.push(text.slice(start, start + maxChars))
  }
  return passages
}

function countOccurrences(text: string, term: string): number {
  let count = 0
  let offset = 0
  while ((offset = text.indexOf(term, offset)) !== -1) {
    count++
    offset += term.length
  }
  return count
}

function extractHtmlTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  return match?.[1].replace(/\s+/g, ' ').trim() ?? ''
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
  // IPv6 unique-local (fc00::/7), link-local (fe80::/10), and multicast (ff00::/8).
  if (
    host.startsWith('fc') ||
    host.startsWith('fd') ||
    host.startsWith('fe80') ||
    host.startsWith('ff')
  )
    return true

  // IPv4-mapped/compatible IPv6 (::ffff:a.b.c.d or ::ffff:xxxx:xxxx) — unwrap
  // and re-check the embedded IPv4 address rather than treating it as an
  // opaque IPv6 literal that slips past the checks below.
  const mappedDotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host)
  if (mappedDotted) return isPrivateHost(mappedDotted[1])
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host)
  if (mappedHex) {
    const hi = Number.parseInt(mappedHex[1], 16)
    const lo = Number.parseInt(mappedHex[2], 16)
    return isPrivateHost(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`)
  }

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])]
    if (a === 0 || a === 127 || a === 10) return true // "this network", loopback, private
    if (a === 100 && b >= 64 && b <= 127) return true // carrier-grade NAT (RFC 6598)
    if (a === 169 && b === 254) return true // link-local
    if (a === 172 && b >= 16 && b <= 31) return true // private
    if (a === 192 && b === 168) return true // private
    if (a >= 224) return true // multicast (224-239) and reserved/future-use (240-255)
  }
  return false
}

function isPrivateAddress(address: string): boolean {
  return isPrivateHost(address)
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}
