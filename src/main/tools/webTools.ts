import { lookup } from 'node:dns/promises'
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { Agent } from 'undici'
import { htmlToReadableText } from './htmlToText'
import type { EvidencePassage, WebFetchArtifactDraft } from '@shared/toolArtifacts.types'
import type { ToolFactory } from './types'
import { recordToolArtifact } from './types'
import { runReadTool } from './helpers'
import { extractPdfText } from './pdfText'

const FETCH_TIMEOUT_MS = 30_000
const MAX_FETCH_BYTES = 1_000_000
/**
 * PDFs get their own, much larger budget because they cannot be read in part.
 * A PDF's cross-reference table and trailer -- which carry `/Root` -- sit at
 * the END of the file, so cutting one at a byte cap does not yield less text,
 * it yields nothing at all: pdf.js rejects the document with "Invalid Root
 * reference". HTML truncates gracefully, which is why one cap served both
 * until a research run measured the difference.
 *
 * Measured on a live run, 11 of 48 fetches returned HTTP 200 and zero
 * characters, and they were disproportionately the authoritative sources the
 * question needed -- DOE, PNNL, MIT and govinfo technical reports. Every one
 * that was sampled fell between 1.3MB and 3.3MB, i.e. just past the old cap.
 * This is set well clear of that range rather than at its edge; it is still a
 * hard bound, and the bytes are transient -- only the extracted text is kept.
 */
const MAX_PDF_FETCH_BYTES = 16_000_000
const MAX_PASSAGES = 8
const MAX_PASSAGE_CHARS = 900
const MAX_TITLE_CHARS = 300
const MAX_URL_CHARS = 4_096

/**
 * A live Critical Thinking retest saw every single selected page — 18 for
 * 18, across many unrelated domains for an ordinary medical/science query —
 * fail identically with `HTTP 403: Forbidden`. A 100% failure rate spanning
 * that many independent sites points at the request signature itself, not
 * anything about the sites: a generic, obviously-non-browser User-Agent
 * (`Anodex/1.0`) with no `Accept`/`Accept-Language` headers is exactly what
 * a lot of ordinary bot-mitigation middleware blanket-rejects, independent
 * of the fetcher's actual intent. This is a single-user, single-fetch-per-
 * URL research tool — already SSRF-safe (DNS-pinned, public-address-only)
 * and already bounded (byte cap, timeout, redirect cap) — sending headers
 * an ordinary browser would send anyway isn't evading anything meant to
 * stop it; it just stops looking like the specific shape of request many
 * WAFs blanket-deny.
 *
 * The set below is a coherent, current Chrome navigation signature: the
 * `Sec-Fetch-*` and `Sec-Ch-Ua*` client-hint headers are what a real browser
 * sends and what many WAFs additionally check for, and Node's `fetch`
 * (undici) does forward them verbatim rather than stripping them as a browser
 * would. The `Chrome` major version is kept consistent between `User-Agent`
 * and `Sec-Ch-Ua` since mismatches are themselves a bot signal. Two limits
 * remain and are unavoidable at this layer: undici forces `Sec-Fetch-Mode` to
 * `cors` (real navigations send `navigate`), and sites behind a JavaScript
 * challenge (e.g. Cloudflare interstitials) cannot be passed by any static
 * header set — those require a real browser engine and are simply unfetchable
 * here.
 */
const CHROME_MAJOR_VERSION = '133'
const FETCH_HEADERS: Record<string, string> = {
  'User-Agent':
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/${CHROME_MAJOR_VERSION}.0.0.0 Safari/537.36`,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Ch-Ua': `"Chromium";v="${CHROME_MAJOR_VERSION}", "Not(A:Brand";v="24", "Google Chrome";v="${CHROME_MAJOR_VERSION}"`,
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1'
}

let extractionQueue: Promise<void> = Promise.resolve()

let resolveHost = async (hostname: string): Promise<string[]> => {
  const records = await lookup(hostname, { all: true, verbatim: true })
  return records.map((record) => record.address)
}

/**
 * fetch_url — read a public web page and return bounded evidence passages.
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
      'Fetch a public URL, retain a structured source artifact, and return up to eight bounded readable passages. Use for documentation, release notes, or known web pages.',
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
          ctx.webSources?.recordAttempt()
          const draft = await fetchUrlEvidence(args.url, ctx.evidenceFocus ?? '', ctx.signal)
          const artifact = recordToolArtifact(ctx, draft)
          const passageText = draft.passages
            .map((passage) => `[${passage.id}] ${passage.text}`)
            .join('\n\n')
          // Verified only when the page actually gave up readable text — a 200
          // that extracts to nothing is no better evidence than a search hit,
          // and claiming otherwise is the whole failure this is meant to catch.
          const sourceId = ctx.webSources?.register({
            title: draft.title,
            url: draft.finalUrl,
            verified: draft.status >= 200 && draft.status < 300 && draft.passages.length > 0
          })
          return {
            modelResult:
              `Source artifact: ${artifact.id}\nTitle: ${draft.title}\nFinal URL: ${draft.finalUrl}\n` +
              `HTTP ${draft.status}; ${draft.contentType}\n` +
              (sourceId ? `Cite as [${sourceId}]\n` : '') +
              `\n${passageText || '(no readable text)'}`,
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
  const extracted = await extractPageEvidence(
    response.body,
    focus,
    signal,
    isPdfContentType(response.contentType)
  )
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
    let current = serverRenderedUrl(assertPublicUrl(rawUrl))
    let unwrapMediaWiki = false
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
          headers: FETCH_HEADERS
        })

        if (REDIRECT_STATUSES.has(response.status)) {
          const location = response.headers.get('location')
          await discardBody(response)
          if (!location) {
            throw new Error(`HTTP ${response.status} redirect with no Location header.`)
          }
          current = serverRenderedUrl(assertPublicUrl(new URL(location, current).toString()))
          continue
        }
        if (!response.ok) {
          await discardBody(response)
          const viaApi =
            response.status === 403 && !unwrapMediaWiki ? mediaWikiApiUrl(current) : null
          if (viaApi) {
            current = assertPublicUrl(viaApi.toString())
            unwrapMediaWiki = true
            continue
          }
          throw new Error(`HTTP ${response.status}: ${response.statusText}`)
        }
        const contentType = response.headers.get('content-type')?.split(';')[0].trim() || 'unknown'
        if (!isReadableContentType(contentType)) {
          await discardBody(response)
          return {
            body: '',
            finalUrl: current.toString(),
            status: response.status,
            contentType,
            truncated: false,
            warnings: [`Unsupported content type: ${contentType}`]
          }
        }
        if (isPdfContentType(contentType)) {
          const pdf = await readResponseBytes(response, MAX_PDF_FETCH_BYTES)
          // A PDF that is a scan, or is malformed, throws here. That is a
          // warning rather than a failed fetch: the run keeps the source and
          // its metadata and moves on, exactly as it did when every PDF was
          // discarded, instead of losing the whole round to one bad file.
          try {
            return {
              body: await extractPdfText(pdf.bytes),
              finalUrl: current.toString(),
              status: response.status,
              contentType,
              truncated: pdf.truncated,
              warnings: pdf.truncated ? [`Response exceeded ${MAX_PDF_FETCH_BYTES} bytes.`] : []
            }
          } catch (error) {
            return {
              body: '',
              finalUrl: current.toString(),
              status: response.status,
              contentType,
              truncated: pdf.truncated,
              warnings: [
                `Could not read that PDF: ${error instanceof Error ? error.message : String(error)}`,
                // Naming the truncation matters more than it looks: cutting a
                // PDF short is itself what makes it unparseable, so without
                // this the stored warning reads as a corrupt file and the byte
                // cap -- the actual cause, and the fixable one -- is invisible.
                ...(pdf.truncated
                  ? [`Response exceeded ${MAX_PDF_FETCH_BYTES} bytes and was truncated.`]
                  : [])
              ]
            }
          }
        }
        const body = await readResponseBody(response, MAX_FETCH_BYTES)
        if (unwrapMediaWiki) {
          const article = mediaWikiArticleHtml(body.text)
          if (!article) {
            throw new Error('HTTP 403: Forbidden')
          }
          return {
            body: article,
            finalUrl: current.toString(),
            status: response.status,
            // The payload is JSON, but what came out of it is the article's own
            // HTML, so the reader downstream should treat it as such.
            contentType: 'text/html',
            truncated: body.truncated,
            warnings: body.truncated ? [`Response exceeded ${MAX_FETCH_BYTES} bytes.`] : []
          }
        }
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

/**
 * Release a response whose body this code is never going to read.
 *
 * `dispatcher.close()` in the caller's `finally` waits for the request to
 * complete, and a response with an unread body never completes — measured
 * directly against a 302 carrying a 2 MB body: `close()` did not return at all,
 * while cancelling the body first closed it in 1 ms. The 30-second fetch
 * timeout does eventually abort and unblock it, so the visible symptom was not
 * a permanent hang but something worse to diagnose: half a minute of dead wait,
 * then `The request timed out or was cancelled` for a page whose redirect was
 * perfectly fine.
 *
 * Three paths reach `finally` without reading: a redirect hop, a non-2xx
 * status, and an unsupported content type. The last is the one most likely to
 * be hit in ordinary use — a model following a link to a PDF gets a large body
 * it was never going to parse.
 */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Already errored or locked; the connection teardown below covers it.
  }
}

/**
 * Hosts that answer a plain HTTP request with a JavaScript shell, and the
 * server-rendered host that serves the same content as HTML.
 *
 * Measured on the same Reddit thread: `www.reddit.com` returns HTTP 200 with
 * 8,468 bytes that extract to zero readable characters, while
 * `old.reddit.com` returns 60,155 bytes that extract to 2,390. A research run
 * fetched seven Reddit threads, got nothing readable from any of them, and
 * spent a whole plan step re-requesting the community sentiment it had in fact
 * already asked for -- the fetches looked successful, so nothing reported a
 * problem.
 *
 * This is a per-host transport workaround, not a general rule, and it is only
 * worth carrying for hosts a research run reaches often.
 */
const SERVER_RENDERED_HOSTS = new Map([
  ['reddit.com', 'old.reddit.com'],
  ['www.reddit.com', 'old.reddit.com']
])

/**
 * Swap a known JavaScript-shell host for the one that serves the same page as
 * HTML. The result is still the page the caller asked for, so it stays the URL
 * that gets cited.
 */
function serverRenderedUrl(url: URL): URL {
  const replacement = SERVER_RENDERED_HOSTS.get(url.hostname.toLowerCase())
  if (!replacement) return url
  const rewritten = new URL(url.toString())
  rewritten.hostname = replacement
  return rewritten
}

/**
 * A wiki article's URL rewritten to the same wiki's MediaWiki API, or null when
 * the URL is not an article path.
 *
 * Fandom -- which hosts a wiki for most games, films and franchises, so a
 * research run reaches it often -- refuses `/wiki/<title>` outright. Measured on
 * one article: the HTML page answers HTTP 403 with 5,854 bytes of refusal, while
 * `api.php?action=parse` on the same host answers HTTP 200 with the article,
 * 4,981 characters of it. A live research step spent three rounds reporting that
 * no source listed a game's built-in scenarios; the page that lists them had
 * been selected and silently lost to that 403.
 *
 * Keyed on the article path rather than the host, so it works for any MediaWiki
 * site, and only ever tried after a refusal, so an ordinary fetch is unchanged.
 */
function mediaWikiApiUrl(url: URL): URL | null {
  const article = /^\/wiki\/(.+)$/.exec(url.pathname)
  if (!article) return null
  const title = decodeURIComponent(article[1])
  if (!title || title.includes('/')) return null
  const api = new URL(`${url.origin}/api.php`)
  api.searchParams.set('action', 'parse')
  api.searchParams.set('page', title)
  api.searchParams.set('prop', 'text')
  api.searchParams.set('format', 'json')
  return api
}

/** The article HTML inside an `action=parse` payload, or null if it is not one. */
function mediaWikiArticleHtml(payload: string): string | null {
  try {
    const parsed = JSON.parse(payload) as { parse?: { text?: Record<string, string> } }
    return parsed.parse?.text?.['*'] ?? null
  } catch {
    return null
  }
}

function isPdfContentType(contentType: string): boolean {
  return contentType === 'application/pdf' || contentType === 'application/x-pdf'
}

function isReadableContentType(contentType: string): boolean {
  return (
    isPdfContentType(contentType) ||
    contentType === 'unknown' ||
    contentType.startsWith('text/') ||
    contentType === 'application/xhtml+xml' ||
    contentType === 'application/json' ||
    contentType.endsWith('+json')
  )
}

/**
 * The byte-level twin of `readResponseBody`, for a format that has to be parsed
 * rather than decoded. Shares the same byte ceiling so one large file cannot
 * cost more than any other.
 */
async function readResponseBytes(
  response: Response,
  maxBytes: number
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const buffer = await response.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  return bytes.byteLength > maxBytes
    ? { bytes: bytes.subarray(0, maxBytes), truncated: true }
    : { bytes, truncated: false }
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

/**
 * A passage that is a long run of short list-marker-delimited items with
 * essentially no sentence structure is navigation/menu/footer chrome rather
 * than readable prose — observed live: a
 * bee-products shop's menu ("Body care * Massage oils * Soaps * Foot care …")
 * and a video page's footer both got extracted and then verified as research
 * "evidence." Rejecting these by structure keeps junk out of the evidence
 * packet and the report generically, without a host-by-host denylist.
 *
 * Kept as a second line of defence now that `htmlToReadableText` drops page
 * chrome at the source: it can only do that for pages that mark their nav and
 * footers as such, and plenty mark nothing.
 * Deliberately conservative — it takes 6+ list markers AND at most one
 * sentence-ending punctuation mark, so a genuine bulleted list of
 * full-sentence findings (e.g. first-aid steps) is kept.
 */
export function looksLikeBoilerplatePassage(text: string): boolean {
  const listMarkers = (text.match(/\s[*•·|›»]\s/g) ?? []).length
  if (listMarkers < 6) return false
  const sentenceEnders = (text.match(/[.!?](?:\s|$)/g) ?? []).length
  return sentenceEnders <= 1
}

/**
 * Words carried by the phrasing of a question rather than its subject. They are
 * excluded from scoring because they say nothing about which passage answers it.
 *
 * Without this the ranker was driven almost entirely by them: for the focus
 * "What are the built-in scenarios and presets that ship with Universe Sandbox",
 * a filler paragraph of "the ... and ... that ..." scored 5200 while the
 * paragraph actually listing the scenarios scored 100. The answer ranked 52x
 * below the noise and fell outside the top MAX_PASSAGES, so the research model
 * reported that evidence as never retrieved and re-requested it every round
 * until the step ran out of rounds.
 */
const FOCUS_STOP_WORDS = new Set([
  'about',
  'after',
  'all',
  'also',
  'and',
  'any',
  'are',
  'because',
  'been',
  'before',
  'being',
  'between',
  'both',
  'but',
  'can',
  'could',
  'did',
  'does',
  'each',
  'for',
  'from',
  'had',
  'has',
  'have',
  'her',
  'here',
  'his',
  'how',
  'into',
  'its',
  'itself',
  'just',
  'like',
  'made',
  'make',
  'many',
  'may',
  'might',
  'more',
  'most',
  'much',
  'must',
  'not',
  'now',
  'off',
  'once',
  'only',
  'other',
  'our',
  'out',
  'over',
  'own',
  'same',
  'she',
  'should',
  'since',
  'some',
  'such',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'too',
  'under',
  'until',
  'use',
  'used',
  'using',
  'very',
  'was',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your'
])

/**
 * How much a passage earns for covering one more distinct focus term. It
 * dominates repetition so that a passage touching several parts of the question
 * outranks one repeating a single word, which is the shape an answer usually has.
 */
const DISTINCT_TERM_WEIGHT = 100

/**
 * Repeats of an already-counted term still carry signal, but with sharply
 * diminishing returns so a long passage cannot win on volume alone.
 */
const REPEAT_HITS_PER_TERM_CAP = 3

export function extractFocusedPassages(text: string, focus: string): EvidencePassage[] {
  const normalized = text.replace(/\r/g, '').trim()
  if (!normalized) return []
  const terms = focusTerms(focus)
  const chunks = normalized
    .split(/\n{2,}/)
    .flatMap((paragraph) => splitLongPassage(paragraph.trim(), MAX_PASSAGE_CHARS))
    .filter((chunk) => Boolean(chunk) && !looksLikeBoilerplatePassage(chunk))
  const ranked = chunks.map((passage, index) => {
    const lower = passage.toLowerCase()
    let distinct = 0
    let repeats = 0
    for (const term of terms) {
      const hits = countWordOccurrences(lower, term)
      if (!hits) continue
      distinct += 1
      repeats += Math.min(hits - 1, REPEAT_HITS_PER_TERM_CAP)
    }
    const score = distinct * DISTINCT_TERM_WEIGHT + repeats - index * 0.01
    return { passage, index, score }
  })
  ranked.sort((a, b) => b.score - a.score || a.index - b.index)
  return ranked.slice(0, MAX_PASSAGES).map((item, index) => ({
    id: `P${index + 1}`,
    text: item.passage,
    score: Math.max(0, Math.round(item.score * 100) / 100)
  }))
}

/** The subject words of a focus: what is left once phrasing is removed. */
function focusTerms(focus: string): string[] {
  const words = focus.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []
  const meaningful = [...new Set(words)].filter((word) => !FOCUS_STOP_WORDS.has(word))
  // A focus made entirely of stop words leaves nothing to rank on. Fall back to
  // the raw words so ordering stays deterministic rather than arbitrary.
  return (meaningful.length ? meaningful : [...new Set(words)]).slice(0, 24)
}

function splitLongPassage(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return text ? [text] : []
  const passages: string[] = []
  for (let start = 0; start < text.length; start += maxChars) {
    passages.push(text.slice(start, start + maxChars))
  }
  return passages
}

/**
 * Occurrences of `term` as a whole word. Substring matching counted "are"
 * inside "software" and "the" inside "other", so a passage could score highly
 * on a focus term it never actually mentions.
 */
function countWordOccurrences(text: string, term: string): number {
  let count = 0
  let offset = 0
  while ((offset = text.indexOf(term, offset)) !== -1) {
    const before = offset === 0 ? '' : text[offset - 1]
    const after = text[offset + term.length] ?? ''
    if (!isWordCharacter(before) && !isWordCharacter(after)) count += 1
    offset += term.length
  }
  return count
}

function isWordCharacter(value: string): boolean {
  return value !== '' && /[a-z0-9]/.test(value)
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
  signal?: AbortSignal,
  // A PDF arrives already extracted to plain text. Running it through the HTML
  // reader would treat a literal `<` in the prose as the start of a tag and
  // would flatten the blank lines that mark its page boundaries, which are what
  // passage splitting keys on.
  isPlainText = false
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
            const text = isPlainText ? body : htmlToReadableText(body)
            resolve({
              title: isPlainText ? '' : extractHtmlTitle(body),
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
