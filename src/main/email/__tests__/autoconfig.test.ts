import { afterEach, describe, expect, it, vi } from 'vitest'
import { discoverEmailConfig, parseIspdb } from '../autoconfig'

vi.mock('../../utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

const ISPDB_XML = `<?xml version="1.0"?>
<clientConfig version="1.1">
  <emailProvider id="example.com">
    <displayName>Example Mail</displayName>
    <incomingServer type="imap">
      <hostname>mail.example.com</hostname>
      <port>993</port>
      <socketType>SSL</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>smtp.example.com</hostname>
      <port>587</port>
      <socketType>STARTTLS</socketType>
      <username>%EMAILLOCALPART%</username>
    </outgoingServer>
  </emailProvider>
</clientConfig>`

describe('email autoconfig', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('routes Gmail addresses to browser sign-in rather than an IMAP form', async () => {
    const config = await discoverEmailConfig('person@gmail.com')

    expect(config).toMatchObject({
      provider: 'gmail',
      authKind: 'oauth',
      source: 'builtin',
      serviceName: 'Gmail'
    })
    // An OAuth provider must not offer server fields up front — there is
    // nothing to fill in, and showing them implies a password is needed.
    expect(config.imap).toBeUndefined()
    expect(config.smtp).toBeUndefined()
  })

  it('offers Gmail an app-password fallback so OAuth is never a dead end', async () => {
    // Gmail's restricted scopes mean a user without a verified OAuth client has
    // to register their own in Google Cloud. IMAP has to stay reachable for
    // anyone who can't finish that.
    const config = await discoverEmailConfig('person@gmail.com')

    expect(config.passwordFallback).toMatchObject({
      requiresAppPassword: true,
      imap: { host: 'imap.gmail.com', port: 993, security: 'tls' },
      smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls' }
    })
    expect(config.passwordFallback?.imap.username).toBe('person@gmail.com')
    expect(config.passwordFallback?.smtp.username).toBe('person@gmail.com')
    expect(config.passwordFallback?.appPasswordUrl).toContain('apppasswords')
  })

  it('offers no fallback for Microsoft, where basic auth was retired', async () => {
    // Offering an IMAP form that cannot possibly authenticate would be worse
    // than offering nothing.
    const config = await discoverEmailConfig('person@outlook.com')

    expect(config.provider).toBe('microsoft')
    expect(config.passwordFallback).toBeUndefined()
  })

  it('routes Outlook-family domains to Microsoft', async () => {
    for (const address of ['a@outlook.com', 'b@hotmail.com', 'c@live.com']) {
      const config = await discoverEmailConfig(address)
      expect(config.provider).toBe('microsoft')
      expect(config.authKind).toBe('oauth')
    }
  })

  it('resolves domain aliases onto the canonical provider settings', async () => {
    const config = await discoverEmailConfig('person@me.com')

    expect(config.provider).toBe('imap')
    expect(config.serviceName).toBe('iCloud Mail')
    expect(config.imap?.host).toBe('imap.mail.me.com')
    expect(config.requiresAppPassword).toBe(true)
    expect(config.appPasswordUrl).toBeTruthy()
  })

  it('fills the username from the typed address for built-in IMAP providers', async () => {
    const config = await discoverEmailConfig('Person@Fastmail.com')

    expect(config.imap?.username).toBe('Person@Fastmail.com')
    expect(config.smtp?.username).toBe('Person@Fastmail.com')
  })

  it('falls back to a conventional guess when nothing knows the domain', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve('') })
    )

    const config = await discoverEmailConfig('person@unknown-domain.test')

    expect(config.source).toBe('guess')
    expect(config.imap?.host).toBe('imap.unknown-domain.test')
    expect(config.smtp?.host).toBe('smtp.unknown-domain.test')
  })

  it('treats a failed ISPDB lookup as a miss, not an error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))

    const config = await discoverEmailConfig('person@unknown-domain.test')

    expect(config.source).toBe('guess')
  })

  it('rejects a value that is not an email address', async () => {
    await expect(discoverEmailConfig('not-an-address')).rejects.toThrow('not a valid email address')
    await expect(discoverEmailConfig('trailing@')).rejects.toThrow('not a valid email address')
  })

  it('reads hosts, ports, and socket types out of ISPDB XML', () => {
    const config = parseIspdb(ISPDB_XML, 'example.com', 'person@example.com')

    expect(config).toMatchObject({
      provider: 'imap',
      source: 'ispdb',
      serviceName: 'Example Mail',
      imap: { host: 'mail.example.com', port: 993, security: 'tls' },
      smtp: { host: 'smtp.example.com', port: 587, security: 'starttls' }
    })
  })

  it('expands both ISPDB username placeholders', () => {
    const config = parseIspdb(ISPDB_XML, 'example.com', 'person@example.com')

    expect(config?.imap?.username).toBe('person@example.com')
    expect(config?.smtp?.username).toBe('person')
  })

  it('returns null when the XML has no IMAP server to use', () => {
    const popOnly = ISPDB_XML.replace('type="imap"', 'type="pop3"')

    expect(parseIspdb(popOnly, 'example.com', 'person@example.com')).toBeNull()
  })
})
