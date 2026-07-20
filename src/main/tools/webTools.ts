import { lookup } from 'node:dns/promises'
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { convert } from 'html-to-text'
import { Agent } from 'undici'
import type { EvidencePassage, WebFetchArtifactDraft } from '@shared/toolArtifacts.types'
import type { ToolFactory } from './types'
import { recordToolArtifact } from './types'
import { runReadTool } from './helpers'

const FETCH_TIMEOUT_MS = 30_000
const MAX_FETCH_BYTES = 1_000_000
const MAX_PASSAGES = 8
const MAX_PASSAGE_CHARS = 900
const MAX_TITLE_CHARS = 300
const MAX_URL_CHARS = 4_096

let extractionQueue: Promise<void> = Promise.resolve()

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
          const draft = await fetchUrlEvidence(args.url, ctx.evidenceFocus ?? '', ctx.signal)
          const artifact = recordToolArtifact(ctx, draft)
          const passageText = draft.passages
            .map((passage) => `[${passage.id}] ${passage.text}`)
            .join('\n\n')
          return {
            modelResult:
              `Source artifact: ${artifact.id}\nTitle: ${draft.title}\nFinal URL: ${draft.finalUrl}\n` +
              `HTTP ${draft.status}; ${draft.contentType}\n\n` +
              (passageText || '(no readable text)'),
            detail: `${draft.contentChars} chars · ${draft.passages.length} focused passages`
          }
        }
      })
  })

/**
 * Fetch and deterministically extract one bounded evidence artifact. Critical
 * Thinking calls this directly so web I/O can be concurrent without putting
 * the local model inside an opaque native function-call loop.
 */
export async function fetchUrlEvidence(
  rawUrl: string,
  focus: string,
  signal?: AbortSignal
): Promise<WebFetchArtifactDraft> {
  const response = await fetchUrl(rawUrl, signal)
  const extracted = await extractPageEvidence(response.body, focus, signal)
  if (signal?.aborted) throw abortError()
  const warnings = [...response.warnings]
  if (extracted.passages.length === 0) {
    warnings.push('No readable evidence passages were extracted.')
  }
  return {
    kind: 'web-fetch',
    requestedUrl: rawUrl,
    finalUrl: response.finalUrl,
    status: response.status,
    contentType: response.contentType,
    title: extracted.title || new URL(response.finalUrl).hostname,
    contentHash: extracted.contentHash,
    contentChars: extracted.contentChars,
    truncated: response.truncated,
    passages: extracted.passages,
    warnings
  }
}

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
  if (signal?.aborted) {
    throw new Error('The request timed out or was cancelled.')
  }
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
      const addresses = await assertPublicDns(current, controller.signal)
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
  return truncate(match?.[1].replace(/\s+/g, ' ').trim() ?? '', MAX_TITLE_CHARS)
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
  if (raw.length > MAX_URL_CHARS) throw new Error('URL is too long to fetch safely.')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`Invalid URL: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only http and https URLs are allowed (got "${url.protocol}").`)
  }
  if (url.username || url.password) {
    throw new Error('URLs containing embedded credentials are not allowed.')
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
async function assertPublicDns(url: URL, signal: AbortSignal): Promise<string[]> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = isIP(hostname) ? [hostname] : await abortable(resolveHost(hostname), signal)
  if (addresses.length === 0) {
    throw new Error(`Could not resolve host (${url.hostname}).`)
  }
  if (addresses.some(isPrivateAddress)) {
    throw new Error(`Refusing to fetch a local or private address (${url.hostname}).`)
  }
  return addresses
}

/** True unless a literal host is safe public IPv4 or allocated global-unicast IPv6. */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  const family = isIP(host)
  if (family === 4) return !isGlobalUnicastIpv4(host)
  if (family === 6) return !isGlobalUnicastIpv6(host)
  return false
}

function isGlobalUnicastIpv4(address: string): boolean {
  const octets = address.split('.').map(Number)
  if (octets.length !== 4 || octets.some((octet) => octet < 0 || octet > 255)) return false
  const [a, b, c] = octets
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false
  if (a === 100 && b >= 64 && b <= 127) return false // shared carrier-grade NAT
  if (a === 169 && b === 254) return false // link-local
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 0 && c === 0) return false // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return false // documentation
  if (a === 192 && b === 88 && c === 99) return false // deprecated 6to4 relay anycast
  if (a === 192 && b === 168) return false
  if (a === 198 && (b === 18 || b === 19)) return false // benchmark testing (RFC 2544)
  if (a === 198 && b === 51 && c === 100) return false // documentation
  if (a === 203 && b === 0 && c === 113) return false // documentation
  return true
}

function isGlobalUnicastIpv6(address: string): boolean {
  const value = ipv6Value(address)
  if (value === null) return false
  // Public IPv6 unicast is currently allocated from 2000::/3. Restricting to
  // that allocation also excludes mapped IPv4, NAT64, discard, unique-local,
  // link/site-local, and multicast ranges.
  const globalUnicast = ipv6Value('2000::')
  if (globalUnicast === null || !inIpv6Range(value, globalUnicast, 3)) return false
  const excluded: Array<[string, number]> = [
    ['2001::', 23], // IETF protocol assignments (Teredo/ORCHID/benchmarking)
    ['2001:db8::', 32], // documentation
    ['2002::', 16], // deprecated 6to4 transition addresses
    ['3ffe::', 16], // deprecated 6bone allocation
    ['3fff::', 20] // documentation
  ]
  return !excluded.some(([network, prefix]) => {
    const networkValue = ipv6Value(network)
    return networkValue !== null && inIpv6Range(value, networkValue, prefix)
  })
}

function ipv6Value(address: string): bigint | null {
  const normalized = address.toLowerCase().split('%')[0]
  const halves = normalized.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  if (halves.length === 1 && left.length !== 8) return null
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0
  if (halves.length === 2 && missing < 1) return null
  const parts = [...left, ...Array.from({ length: missing }, () => '0'), ...right]
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null
  return parts.reduce((total, part) => (total << 16n) | BigInt(`0x${part}`), 0n)
}

function inIpv6Range(value: bigint, network: bigint, prefix: number): boolean {
  const shift = BigInt(128 - prefix)
  return value >> shift === network >> shift
}

function isPrivateAddress(address: string): boolean {
  return isPrivateHost(address)
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup()
      reject(abortError())
    }
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(asError(error, 'DNS resolution failed.'))
      }
    )
  })
}

function abortError(): Error {
  const error = new Error('The request was cancelled.')
  error.name = 'AbortError'
  return error
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback, { cause: error })
}

function extractPageEvidence(
  body: string,
  focus: string,
  signal?: AbortSignal
): Promise<{
  title: string
  contentHash: string
  contentChars: number
  passages: EvidencePassage[]
}> {
  const task = extractionQueue.then(
    () =>
      new Promise<{
        title: string
        contentHash: string
        contentChars: number
        passages: EvidencePassage[]
      }>((resolve, reject) => {
        setImmediate(() => {
          if (signal?.aborted) {
            reject(abortError())
            return
          }
          try {
            const text = convert(body, {
              selectors: [
                { selector: 'a', options: { ignoreHref: true } },
                { selector: 'img', format: 'skip' }
              ]
            }).trim()
            resolve({
              title: extractHtmlTitle(body),
              contentHash: createHash('sha256').update(body).digest('hex'),
              contentChars: text.length,
              passages: extractFocusedPassages(text, focus)
            })
          } catch (error) {
            reject(asError(error, 'Failed to extract webpage evidence.'))
          }
        })
      })
  )
  extractionQueue = task.then(
    () => undefined,
    () => undefined
  )
  return task
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return max <= 1 ? '…'.slice(0, max) : `${text.slice(0, max - 1)}…`
}
