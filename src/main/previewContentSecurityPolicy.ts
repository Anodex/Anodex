/**
 * A content security policy for the AI-written pages Anodex previews.
 *
 * The pop-out preview window is otherwise careful: sandbox on, no preload, no
 * node integration, and content served from a `data:` URL so the page has an
 * opaque origin and can neither read the disk nor reach app state. What an
 * opaque origin does not prevent is an *outbound* cross-origin request — a
 * `fetch`, or an `img` whose `src` carries data in its query string.
 *
 * The window already blocks network traffic, but only while an AI-control
 * session is active (`controlEnabledKeys` in `htmlPreviewWindow.ts`). Outside
 * one, requests pass.
 *
 * The chain this closes: a model reads a file, embeds what it read in a page,
 * the user opens the preview, and the page beacons it out. No exploit has been
 * observed. This is hardening, not a fixed defect.
 *
 * It costs nothing because it matches the design already documented:
 * `prepareHtmlPreviewSource` inlines local stylesheets, scripts and images
 * precisely because an opaque origin cannot fetch its own siblings. A preview
 * that needs the network is already unsupported.
 */
const POLICY = [
  // Everything is denied unless named below.
  "default-src 'none'",
  // Inline is the whole point: every asset was inlined before this ran, and a
  // policy forbidding inline code would blank every preview Anodex produces.
  // `unsafe-eval` stays because AI-written pages use libraries that need it,
  // and it does not weaken the network rules, which are what this is for.
  "script-src 'unsafe-inline' 'unsafe-eval' data: blob:",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  // Workers are not covered by any directive above, so without this they fall
  // through to `default-src 'none'` and a page that uses one silently stops
  // working. AI-written games and animations reach for them, and blocking them
  // buys nothing: a worker has no more network reach than its parent under
  // `connect-src 'none'`.
  'worker-src blob: data:',
  'child-src blob: data:',
  // The rules that matter: no outbound requests, no form posts, and no
  // rewriting relative URLs out of the sandbox.
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "object-src 'none'"
].join('; ')

const META = `<meta http-equiv="Content-Security-Policy" content="${POLICY}">`

const HEAD_OPEN = /<head\b[^>]*>/i

/**
 * Insert the policy as the first thing in `<head>`, so it is in force before
 * anything in the document can run.
 *
 * A document with no `<head>` gets one: a model may emit a bare fragment, and a
 * meta tag with nowhere to live would silently apply nothing at all.
 *
 * A document that already carries a policy is left alone. Two policies
 * intersect rather than replace, so adding a second can only ever tighten a
 * page in ways its author did not intend — and re-hardening an already
 * hardened page would do exactly that.
 */
export function withContentSecurityPolicy(html: string): string {
  if (/http-equiv\s*=\s*["']?Content-Security-Policy/i.test(html)) return html

  const head = HEAD_OPEN.exec(html)
  if (head) {
    const at = head.index + head[0].length
    return `${html.slice(0, at)}${META}${html.slice(at)}`
  }

  // No head: put one at the top of the document. Placed before any `<body>` so
  // the policy precedes anything that could execute.
  const htmlOpen = /<html\b[^>]*>/i.exec(html)
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length
    return `${html.slice(0, at)}<head>${META}</head>${html.slice(at)}`
  }
  return `<head>${META}</head>${html}`
}
