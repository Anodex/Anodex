/**
 * Decides which remote requests a page under visual inspection may make.
 *
 * ## Why this exists
 *
 * `inspect_visual` renders a workspace page in a throwaway `BrowserWindow` and
 * cancels remote requests, so an inspected page cannot quietly reach the
 * network. The original allowlist was a single regex over `src=`/`href=`
 * attributes on `<script|link|img|source>` tags. That missed the one place
 * modern pages actually declare their dependencies — the
 * `<script type="importmap">` JSON body — so a page importing three.js from a
 * CDN had an *empty* allowlist, every module request was cancelled, and the
 * canvas rendered blank in every inspection no matter what the project's own
 * code did. Anodex then reported that blank render to the model as fact, and a
 * whole debugging session was spent chasing a defect the inspector had
 * manufactured. See `docs/REVIEW_LOG_VISUAL_RUNTIME_EVIDENCE.md`.
 *
 * ## What this does instead
 *
 * Parses declarations *structurally* — import maps (`imports` and `scopes`),
 * asset attributes, and CSS `url()` references — and permits only those exact
 * URLs, plus anything beneath a declared prefix mapping. Every decision carries
 * a machine-readable reason so a blocked request can be reported to the model
 * rather than silently vanishing. Silence was the actual bug; a blocked CDN
 * that says so is recoverable, one that says nothing is not.
 *
 * ## Declaration is necessary but not sufficient
 *
 * A page in the workspace declares its own URLs, so "was this declared" alone
 * would make the inspector an SSRF primitive: a page could declare
 * `http://127.0.0.1:11434/...` (a local model server), a router admin page, or
 * a cloud metadata address, and a purely declaration-based rule would allow it.
 * Every candidate is therefore also checked against
 * {@link isPrivateNetworkTarget} and denied if it names a loopback, link-local,
 * or private-range host — with a single exception for the inspection server's
 * own origin, which is how the page itself is served.
 *
 * ## Known residual risk
 *
 * Host checking is *literal*. A declared public hostname whose DNS resolves to
 * a private address (DNS rebinding) is not caught here, because
 * `webRequest.onBeforeRequest` sees the URL, not the resolved peer address.
 * Closing that needs resolution-time filtering at the network layer. Recorded
 * deliberately rather than papered over; it is strictly narrower than the
 * previous behavior, which had no host checking at all.
 */

/** Why a request was refused, for reporting back to the model. */
export type BlockedRequestReason =
  /** The page never declared this URL in an import map, asset tag, or stylesheet. */
  | 'not-declared'
  /** Declared, but names a loopback/link-local/private host (see the SSRF note above). */
  | 'private-address'
  /** Not an `http(s)` URL — `file:`, `ftp:`, `ws:` and friends are never served here. */
  | 'unsupported-scheme'

export interface AssetDecision {
  allowed: boolean
  /** Set only when `allowed` is false. */
  reason?: BlockedRequestReason
}

/** The declarations found in one page, before any host policy is applied. */
export interface DeclaredAssets {
  /** Fully-specified URLs the page named verbatim. */
  exact: Set<string>
  /**
   * Prefix mappings from import-map keys ending in `/`. Import maps resolve
   * `three/addons/controls/OrbitControls.js` against a `three/addons/` entry
   * whose value is a directory URL, so the concrete request URL never appears
   * verbatim anywhere in the document. Matching exact URLs only would still
   * block every submodule of a mapped package — which is most of three.js.
   */
  prefixes: string[]
}

export interface ExternalAssetPolicy {
  /** Whether the inspected page may issue this request, and why not if it may not. */
  decide(url: string): AssetDecision
  /** Everything the page declared, for logging and tests. */
  readonly declared: DeclaredAssets
}

interface PolicyOptions {
  /**
   * Origin the page itself is served from (the loopback inspection server).
   * Always permitted despite being a private address — without it the page
   * could not load its own stylesheets, scripts, or images.
   */
  serverOrigin?: string
}

/** `src`/`href` on the tags that can pull a subresource. */
const ASSET_ATTRIBUTE_PATTERN =
  /<(?:script|link|img|source|iframe|video|audio|track|embed)\b[^>]+?\b(?:src|href)=["']([^"']+)["']/gi

/** `<script type="importmap">…</script>`, including `importmap-shim` variants. */
const IMPORT_MAP_PATTERN =
  /<script\b[^>]*\btype=["']importmap(?:-shim)?["'][^>]*>([\s\S]*?)<\/script>/gi

/** `url(...)` inside stylesheets — inlined `<style>` blocks included. */
const CSS_URL_PATTERN = /url\(\s*["']?([^"')]+)["']?\s*\)/gi

/** Absolute `http(s)` URL. Protocol-relative (`//host/x`) is normalized separately. */
const ABSOLUTE_HTTP_URL = /^https?:\/\//i

/**
 * Collect every remote URL the page declares, from all three declaration
 * surfaces. Relative and `data:` references are ignored: they are served from
 * the inspection server or inlined, and never reach the network filter.
 */
export function collectDeclaredAssets(html: string): DeclaredAssets {
  const exact = new Set<string>()
  const prefixes: string[] = []

  for (const [, body] of html.matchAll(IMPORT_MAP_PATTERN)) {
    collectImportMap(body, exact, prefixes)
  }
  for (const [, url] of html.matchAll(ASSET_ATTRIBUTE_PATTERN)) {
    addExact(exact, url)
  }
  for (const [, url] of html.matchAll(CSS_URL_PATTERN)) {
    addExact(exact, url)
  }

  return { exact, prefixes }
}

/**
 * Parse one import-map body. A malformed map is skipped rather than thrown:
 * the browser ignores invalid import maps too, and an inspection that fails
 * outright would be strictly less useful than one that renders with fewer
 * permitted origins and reports the blocks.
 */
function collectImportMap(body: string, exact: Set<string>, prefixes: string[]): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return
  }
  if (!isRecord(parsed)) return

  collectSpecifierMap(parsed.imports, exact, prefixes)
  if (isRecord(parsed.scopes)) {
    for (const scoped of Object.values(parsed.scopes)) {
      collectSpecifierMap(scoped, exact, prefixes)
    }
  }
}

/**
 * A specifier map is `{ specifier: target }`. A specifier ending in `/` makes
 * its target a *prefix* every nested path resolves against; anything else is a
 * single concrete URL.
 */
function collectSpecifierMap(map: unknown, exact: Set<string>, prefixes: string[]): void {
  if (!isRecord(map)) return
  for (const [specifier, target] of Object.entries(map)) {
    if (typeof target !== 'string') continue
    const normalized = normalizeUrl(target)
    if (normalized === null) continue
    if (specifier.endsWith('/') || target.endsWith('/')) prefixes.push(normalized)
    else exact.add(normalized)
  }
}

function addExact(exact: Set<string>, url: string): void {
  const normalized = normalizeUrl(url)
  if (normalized !== null) exact.add(normalized)
}

/**
 * Reduce a declared reference to a comparable absolute `http(s)` URL, or null
 * if it is not a remote request at all. Fragments are stripped because they
 * never reach the network; protocol-relative URLs are resolved to `https:`,
 * matching how the page would load them from an `http(s)` origin.
 */
function normalizeUrl(url: string): string | null {
  const trimmed = url.trim()
  if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('#')) return null
  const absolute = trimmed.startsWith('//') ? `https:${trimmed}` : trimmed
  if (!ABSOLUTE_HTTP_URL.test(absolute)) return null
  try {
    const parsed = new URL(absolute)
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return null
  }
}

/**
 * Build the policy for one inspection. `serverOrigin` is the loopback origin
 * the page is served from and is always permitted.
 */
export function createExternalAssetPolicy(
  html: string,
  options: PolicyOptions = {}
): ExternalAssetPolicy {
  const declared = collectDeclaredAssets(html)
  const serverOrigin = options.serverOrigin ? safeOrigin(options.serverOrigin) : null

  return {
    declared,
    decide(url: string): AssetDecision {
      const normalized = normalizeUrl(url)
      if (normalized === null) return { allowed: false, reason: 'unsupported-scheme' }

      // The page's own origin: always permitted, and checked before the private
      // -address rule, which would otherwise reject the loopback server itself.
      if (serverOrigin !== null && safeOrigin(normalized) === serverOrigin) {
        return { allowed: true }
      }

      if (!isDeclared(declared, normalized)) return { allowed: false, reason: 'not-declared' }
      if (isPrivateNetworkTarget(normalized)) return { allowed: false, reason: 'private-address' }
      return { allowed: true }
    }
  }
}

function isDeclared(declared: DeclaredAssets, url: string): boolean {
  if (declared.exact.has(url)) return true
  return declared.prefixes.some((prefix) => url.startsWith(prefix))
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/** Hostnames that always denote the local machine or a local-only namespace. */
const LOCAL_HOSTNAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost'])

/**
 * Whether a URL names a host on the local machine or a private/link-local
 * network. Literal-address matching only — see the DNS-rebinding note in the
 * module comment.
 */
export function isPrivateNetworkTarget(url: string): boolean {
  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    // Unparseable is treated as private: refusing an address we cannot
    // classify is the safe direction for a network filter.
    return true
  }

  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (LOCAL_HOSTNAMES.has(host)) return true
  // `.localhost` is reserved for loopback, and `.local` is mDNS — both resolve
  // only within the local machine or link.
  if (host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (isPrivateIpv4(host)) return true
  return isPrivateIpv6(host)
}

function isPrivateIpv4(host: string): boolean {
  const octets = host.split('.')
  if (octets.length !== 4) return false
  const parts = octets.map((octet) => (/^\d{1,3}$/.test(octet) ? Number(octet) : Number.NaN))
  if (parts.some((part) => Number.isNaN(part) || part > 255)) return false
  const [a, b] = parts

  if (a === 0) return true // "this network"
  if (a === 10) return true // RFC1918
  if (a === 127) return true // loopback
  if (a === 169 && b === 254) return true // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true // RFC1918
  if (a === 192 && b === 168) return true // RFC1918
  if (a === 192 && b === 0) return true // IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
  return a >= 224 // multicast + reserved
}

function isPrivateIpv6(host: string): boolean {
  if (!host.includes(':')) return false
  if (host === '::' || host === '::1') return true

  const embedded = embeddedIpv4(host)
  if (embedded !== null) return isPrivateIpv4(embedded)

  const prefix = host.slice(0, 4).toLowerCase()
  // fc00::/7 unique-local, fe80::/10 link-local.
  return /^f[cd]/.test(prefix) || /^fe[89ab]/.test(prefix)
}

/**
 * The IPv4 address embedded in an IPv4-mapped IPv6 host, as a dotted quad.
 *
 * Both spellings have to be handled. A page may write `::ffff:127.0.0.1`, but
 * `new URL()` normalizes that to the hex form `::ffff:7f00:1` before we ever
 * see it — so matching only the dotted form silently let every IPv4-mapped
 * loopback and RFC1918 address through the private-address check.
 */
function embeddedIpv4(host: string): string | null {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(host)
  if (dotted) return dotted[1]

  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host)
  if (!hex) return null
  const high = Number.parseInt(hex[1], 16)
  const low = Number.parseInt(hex[2], 16)
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
