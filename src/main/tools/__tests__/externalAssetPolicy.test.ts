import { describe, expect, it } from 'vitest'
import {
  collectDeclaredAssets,
  createExternalAssetPolicy,
  isPrivateNetworkTarget
} from '../externalAssetPolicy'

/**
 * The exact head of the page from the driving incident. Its three.js URLs live
 * only inside the import-map JSON body — the case the previous
 * attribute-only allowlist missed entirely, leaving the allowlist empty and
 * guaranteeing a blank canvas in every inspection.
 */
const INCIDENT_HTML = `<!DOCTYPE html>
<html>
<head>
  <link rel="stylesheet" href="style.css">
  <script type="importmap">
  {
    "imports": {
      "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
      "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"
    }
  }
  </script>
</head>
<body>
  <script type="module" src="js/universe-sandbox.js"></script>
</body>
</html>`

describe('collectDeclaredAssets', () => {
  it('finds import-map URLs the attribute-only allowlist missed', () => {
    const declared = collectDeclaredAssets(INCIDENT_HTML)

    expect(declared.exact).toContain(
      'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js'
    )
  })

  it('records a trailing-slash specifier as a prefix, not an exact URL', () => {
    const declared = collectDeclaredAssets(INCIDENT_HTML)

    expect(declared.prefixes).toContain('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/')
  })

  it('collects scoped import-map entries', () => {
    const declared = collectDeclaredAssets(`
      <script type="importmap">
      { "scopes": { "/vendor/": { "lit": "https://cdn.example.test/lit.js" } } }
      </script>
    `)

    expect(declared.exact).toContain('https://cdn.example.test/lit.js')
  })

  it('collects asset attributes and CSS url() references', () => {
    const declared = collectDeclaredAssets(`
      <img src="https://img.example.test/a.png">
      <style>@font-face { src: url("https://fonts.example.test/f.woff2"); }</style>
    `)

    expect(declared.exact).toContain('https://img.example.test/a.png')
    expect(declared.exact).toContain('https://fonts.example.test/f.woff2')
  })

  it('ignores relative, data:, and fragment references', () => {
    const declared = collectDeclaredAssets(
      '<script src="js/app.js"></script><img src="data:image/png;base64,AA"><a href="#top">'
    )

    expect(declared.exact.size).toBe(0)
  })

  it('skips a malformed import map instead of throwing', () => {
    expect(() =>
      collectDeclaredAssets('<script type="importmap">{ not json }</script>')
    ).not.toThrow()
  })
})

describe('createExternalAssetPolicy', () => {
  it('allows a bare-specifier module declared only in the import map', () => {
    const policy = createExternalAssetPolicy(INCIDENT_HTML)

    expect(
      policy.decide('https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js')
    ).toEqual({ allowed: true })
  })

  it('allows a submodule resolved beneath a prefix mapping', () => {
    const policy = createExternalAssetPolicy(INCIDENT_HTML)

    // `three/addons/controls/OrbitControls.js` resolves to this URL, which
    // appears verbatim nowhere in the document.
    expect(
      policy.decide(
        'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js'
      )
    ).toEqual({ allowed: true })
  })

  it('blocks an undeclared origin with a reportable reason', () => {
    const policy = createExternalAssetPolicy(INCIDENT_HTML)

    expect(policy.decide('https://tracker.example.test/beacon.js')).toEqual({
      allowed: false,
      reason: 'not-declared'
    })
  })

  it('blocks a declared but private address, so declaring is not sufficient', () => {
    const policy = createExternalAssetPolicy(
      '<script src="http://127.0.0.1:11434/api/generate"></script>'
    )

    expect(policy.decide('http://127.0.0.1:11434/api/generate')).toEqual({
      allowed: false,
      reason: 'private-address'
    })
  })

  it('blocks the cloud metadata address even when declared', () => {
    const policy = createExternalAssetPolicy('<img src="http://169.254.169.254/latest/meta-data/">')

    expect(policy.decide('http://169.254.169.254/latest/meta-data/').reason).toBe('private-address')
  })

  it('allows the inspection server origin that serves the page itself', () => {
    const policy = createExternalAssetPolicy(INCIDENT_HTML, {
      serverOrigin: 'http://127.0.0.1:52341'
    })

    expect(policy.decide('http://127.0.0.1:52341/js/universe-sandbox.js')).toEqual({
      allowed: true
    })
  })

  it('does not extend the server exception to another local port', () => {
    const policy = createExternalAssetPolicy(INCIDENT_HTML, {
      serverOrigin: 'http://127.0.0.1:52341'
    })

    expect(policy.decide('http://127.0.0.1:11434/api/generate').allowed).toBe(false)
  })

  it('rejects non-http schemes', () => {
    const policy = createExternalAssetPolicy(INCIDENT_HTML)

    expect(policy.decide('file:///C:/Windows/System32/drivers/etc/hosts')).toEqual({
      allowed: false,
      reason: 'unsupported-scheme'
    })
  })
})

describe('isPrivateNetworkTarget', () => {
  const privateTargets = [
    'http://localhost/x',
    'http://app.localhost/x',
    'http://printer.local/x',
    'http://127.0.0.1/x',
    'http://10.1.2.3/x',
    'http://172.16.0.1/x',
    'http://172.31.255.255/x',
    'http://192.168.1.1/x',
    'http://169.254.169.254/x',
    'http://100.64.0.1/x',
    'http://0.0.0.0/x',
    'http://[::1]/x',
    'http://[fe80::1]/x',
    'http://[fd00::1]/x',
    'http://[::ffff:127.0.0.1]/x'
  ]

  it.each(privateTargets)('treats %s as private', (url) => {
    expect(isPrivateNetworkTarget(url)).toBe(true)
  })

  const publicTargets = [
    'https://cdn.jsdelivr.net/npm/three/build/three.module.js',
    'https://example.com/x',
    'http://172.32.0.1/x',
    'http://11.0.0.1/x'
  ]

  it.each(publicTargets)('treats %s as public', (url) => {
    expect(isPrivateNetworkTarget(url)).toBe(false)
  })
})
