import { describe, expect, it } from 'vitest'
import { withContentSecurityPolicy } from '../previewContentSecurityPolicy'

/**
 * The pop-out preview renders AI-written HTML, and nothing stopped that page
 * talking to the network.
 *
 * The window's own security posture is otherwise careful — sandbox on, no
 * preload, no node integration, and content served from a `data:` URL so the
 * page has an opaque origin and cannot read the disk or reach app state. What
 * an opaque origin does not prevent is an outbound cross-origin request: a
 * `fetch`, or an `img` whose `src` is a URL with data in the query string.
 *
 * There is a network blocker on this window already, but it is armed only
 * during an AI-control session (`controlEnabledKeys`). Outside one, requests
 * pass.
 *
 * The chain that matters: a model reads a file, embeds what it read in a page,
 * the user opens the preview, and the page beacons it out. No exploit has been
 * observed — this is hardening, not a fixed defect.
 *
 * It costs nothing to match the design that is already documented.
 * `prepareHtmlPreviewSource` inlines local stylesheets, scripts and images
 * precisely because an opaque origin cannot fetch its own siblings, so a
 * preview that needs the network is already unsupported.
 */
describe('preview content security policy', () => {
  it('blocks network and forms by default', () => {
    const policy = withContentSecurityPolicy('<html><head></head><body>hi</body></html>')
    expect(policy).toContain("default-src 'none'")
    expect(policy).toContain("connect-src 'none'")
    expect(policy).toContain("form-action 'none'")
  })

  it('still allows the inline script and style a preview is built from', () => {
    // Every asset is inlined before this runs, so a policy that forbade inline
    // code would blank every preview Anodex produces.
    const policy = withContentSecurityPolicy('<html><head></head><body></body></html>')
    expect(policy).toMatch(/script-src[^;]*'unsafe-inline'/)
    expect(policy).toMatch(/style-src[^;]*'unsafe-inline'/)
    expect(policy).toMatch(/img-src[^;]*data:/)
  })

  it('allows a worker, which no other directive covers', () => {
    // Not listed means `default-src 'none'`, and a page using a Worker stops
    // working with nothing to say why. A worker gains no network reach here:
    // `connect-src 'none'` applies to it too.
    const policy = withContentSecurityPolicy('<html><head></head></html>')
    expect(policy).toMatch(/worker-src[^;]*blob:/)
  })

  it('puts the policy inside head, before anything that could run', () => {
    const html = '<html><head><title>t</title></head><body><script>1</script></body></html>'
    const policy = withContentSecurityPolicy(html)
    expect(policy.indexOf('Content-Security-Policy')).toBeLessThan(policy.indexOf('<title>'))
    expect(policy).toContain('<title>t</title>')
  })

  it('gives a document with no head one', () => {
    // A model may emit a bare fragment; a meta tag with nowhere to live would
    // silently apply nothing.
    const policy = withContentSecurityPolicy('<body><p>bare</p></body>')
    expect(policy).toContain('Content-Security-Policy')
    expect(policy).toContain('<p>bare</p>')
  })

  it('handles a head with attributes', () => {
    const policy = withContentSecurityPolicy('<html><head lang="en"><title>t</title></head></html>')
    expect(policy.indexOf('Content-Security-Policy')).toBeLessThan(policy.indexOf('<title>'))
  })

  it('does not add a second policy to a page that already has one', () => {
    // A page Anodex previously hardened, or a hand-written page with its own
    // policy: two meta tags intersect, and the stricter one silently wins.
    const once = withContentSecurityPolicy('<html><head></head><body></body></html>')
    const twice = withContentSecurityPolicy(once)
    expect(twice.match(/Content-Security-Policy/g)).toHaveLength(1)
  })
})
