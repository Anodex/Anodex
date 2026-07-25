import type { EmailAutoconfig, EmailEndpoint, EmailSocketSecurity } from '@shared/email.types'
import { createLogger } from '../utils/logger'

const log = createLogger('email:autoconfig')

const ISPDB_TIMEOUT_MS = 6_000

/**
 * Domains served by a provider Anodex talks to natively. The user gets a
 * sign-in button rather than a server form — but see `passwordFallback`, which
 * keeps IMAP reachable for providers where OAuth needs setup the user may not
 * be able to complete.
 */
const OAUTH_DOMAINS: Record<
  string,
  { provider: 'gmail' | 'microsoft'; serviceName: string; imapFallback?: boolean }
> = {
  'gmail.com': { provider: 'gmail', serviceName: 'Gmail', imapFallback: true },
  'googlemail.com': { provider: 'gmail', serviceName: 'Gmail', imapFallback: true },
  // Microsoft deliberately has no fallback: basic authentication for personal
  // Outlook accounts was retired in 2024, so IMAP with an app password no
  // longer works there and offering it would only fail confusingly.
  'outlook.com': { provider: 'microsoft', serviceName: 'Outlook' },
  'hotmail.com': { provider: 'microsoft', serviceName: 'Outlook' },
  'live.com': { provider: 'microsoft', serviceName: 'Outlook' },
  'msn.com': { provider: 'microsoft', serviceName: 'Outlook' },
  'passport.com': { provider: 'microsoft', serviceName: 'Outlook' }
}

/**
 * Gmail over IMAP, used when a user opts out of OAuth. Requires an app
 * password, which in turn requires 2-Step Verification on the account —
 * Google removed plain-password IMAP access years ago.
 */
const GMAIL_IMAP_FALLBACK = {
  serviceName: 'Gmail',
  imap: { host: 'imap.gmail.com', port: 993, security: 'tls' as const },
  smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls' as const },
  appPasswordUrl: 'https://myaccount.google.com/apppasswords',
  requiresAppPassword: true,
  note: 'Needs 2-Step Verification and an app password, but no Google Cloud project, OAuth client, or app verification.'
}

interface BuiltinImapConfig {
  serviceName: string
  imap: Omit<EmailEndpoint, 'username'>
  smtp: Omit<EmailEndpoint, 'username'>
  appPasswordUrl?: string
  requiresAppPassword?: boolean
}

/**
 * Hand-maintained settings for the large consumer providers. These are checked
 * before the network lookup so the common cases resolve instantly and still
 * work with no connectivity — and so the app-password guidance, which the ISPDB
 * does not carry, is always present where it is mandatory.
 */
const BUILTIN_IMAP: Record<string, BuiltinImapConfig> = {
  'icloud.com': {
    serviceName: 'iCloud Mail',
    imap: { host: 'imap.mail.me.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.mail.me.com', port: 587, security: 'starttls' },
    appPasswordUrl: 'https://account.apple.com/account/manage',
    requiresAppPassword: true
  },
  'yahoo.com': {
    serviceName: 'Yahoo Mail',
    imap: { host: 'imap.mail.yahoo.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, security: 'tls' },
    appPasswordUrl: 'https://login.yahoo.com/account/security',
    requiresAppPassword: true
  },
  'aol.com': {
    serviceName: 'AOL Mail',
    imap: { host: 'imap.aol.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.aol.com', port: 465, security: 'tls' },
    appPasswordUrl: 'https://login.aol.com/account/security',
    requiresAppPassword: true
  },
  'fastmail.com': {
    serviceName: 'Fastmail',
    imap: { host: 'imap.fastmail.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.fastmail.com', port: 465, security: 'tls' },
    appPasswordUrl: 'https://app.fastmail.com/settings/security/apps',
    requiresAppPassword: true
  },
  'proton.me': {
    serviceName: 'Proton Mail (Bridge)',
    imap: { host: '127.0.0.1', port: 1143, security: 'starttls' },
    smtp: { host: '127.0.0.1', port: 1025, security: 'starttls' },
    appPasswordUrl: 'https://proton.me/mail/bridge',
    requiresAppPassword: true
  },
  'zoho.com': {
    serviceName: 'Zoho Mail',
    imap: { host: 'imap.zoho.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.zoho.com', port: 465, security: 'tls' },
    appPasswordUrl: 'https://accounts.zoho.com/home#security/apppasswords'
  },
  'gmx.com': {
    serviceName: 'GMX',
    imap: { host: 'imap.gmx.com', port: 993, security: 'tls' },
    smtp: { host: 'mail.gmx.com', port: 587, security: 'starttls' }
  }
}

/** Aliases that share another domain's servers. */
const DOMAIN_ALIASES: Record<string, string> = {
  'me.com': 'icloud.com',
  'mac.com': 'icloud.com',
  'ymail.com': 'yahoo.com',
  'rocketmail.com': 'yahoo.com',
  'fastmail.fm': 'fastmail.com',
  'protonmail.com': 'proton.me',
  'protonmail.ch': 'proton.me',
  'pm.me': 'proton.me',
  'zohomail.com': 'zoho.com',
  'gmx.net': 'gmx.com',
  'gmx.de': 'gmx.com'
}

/**
 * Works out how to connect to whatever mailbox an address belongs to, so the
 * user only ever has to type the address itself.
 *
 * Resolution order: native-provider domains, then the built-in IMAP table,
 * then Mozilla's ISPDB (the same autoconfig database Thunderbird uses), then a
 * conventional `imap.<domain>` / `smtp.<domain>` guess the user can correct.
 */
export async function discoverEmailConfig(rawAddress: string): Promise<EmailAutoconfig> {
  const address = rawAddress.trim()
  const at = address.lastIndexOf('@')
  if (at <= 0 || at === address.length - 1) {
    throw new Error(`"${rawAddress}" is not a valid email address.`)
  }

  const domain = address.slice(at + 1).toLowerCase()
  const canonical = DOMAIN_ALIASES[domain] ?? domain

  const oauth = OAUTH_DOMAINS[canonical]
  if (oauth) {
    return {
      address,
      domain,
      provider: oauth.provider,
      authKind: 'oauth',
      serviceName: oauth.serviceName,
      source: 'builtin',
      ...(oauth.imapFallback
        ? {
            passwordFallback: {
              ...GMAIL_IMAP_FALLBACK,
              imap: { ...GMAIL_IMAP_FALLBACK.imap, username: address },
              smtp: { ...GMAIL_IMAP_FALLBACK.smtp, username: address }
            }
          }
        : {})
    }
  }

  const builtin = BUILTIN_IMAP[canonical]
  if (builtin) {
    return {
      address,
      domain,
      provider: 'imap',
      authKind: 'password',
      serviceName: builtin.serviceName,
      source: 'builtin',
      imap: { ...builtin.imap, username: address },
      smtp: { ...builtin.smtp, username: address },
      appPasswordUrl: builtin.appPasswordUrl,
      requiresAppPassword: builtin.requiresAppPassword
    }
  }

  const ispdb = await lookupIspdb(domain, address)
  if (ispdb) return ispdb

  // Convention-based guess. Wrong often enough that the UI must present these
  // as editable rather than final, which is why `source` is reported.
  return {
    address,
    domain,
    provider: 'imap',
    authKind: 'password',
    serviceName: domain,
    source: 'guess',
    imap: { host: `imap.${domain}`, port: 993, security: 'tls', username: address },
    smtp: { host: `smtp.${domain}`, port: 587, security: 'starttls', username: address }
  }
}

/**
 * Mozilla's ISPDB, the autoconfig database Thunderbird ships against. A miss or
 * a network failure is not an error — the caller falls back to a guess.
 */
async function lookupIspdb(domain: string, address: string): Promise<EmailAutoconfig | null> {
  const url = `https://autoconfig.thunderbird.net/v1.1/${encodeURIComponent(domain)}`
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(ISPDB_TIMEOUT_MS) })
    if (!response.ok) return null
    return parseIspdb(await response.text(), domain, address)
  } catch (error) {
    log.info(`ISPDB lookup for ${domain} did not resolve:`, error)
    return null
  }
}

/**
 * Reads the subset of Mozilla's autoconfig XML that matters here: the first
 * IMAP incoming server and the first SMTP outgoing server. Parsed with regex
 * rather than an XML dependency — the schema is small, stable, and this only
 * ever reads two elements out of it.
 *
 * Exported for testing.
 */
export function parseIspdb(xml: string, domain: string, address: string): EmailAutoconfig | null {
  const incoming = matchServer(xml, 'incomingServer', 'imap')
  const outgoing = matchServer(xml, 'outgoingServer', 'smtp')
  if (!incoming || !outgoing) return null

  const displayName = xml.match(/<displayName>([^<]+)<\/displayName>/)?.[1]?.trim()

  return {
    address,
    domain,
    provider: 'imap',
    authKind: 'password',
    serviceName: displayName || domain,
    source: 'ispdb',
    imap: { ...incoming, username: resolveUsername(incoming.username, address) },
    smtp: { ...outgoing, username: resolveUsername(outgoing.username, address) }
  }
}

function matchServer(
  xml: string,
  element: 'incomingServer' | 'outgoingServer',
  type: 'imap' | 'smtp'
): (Omit<EmailEndpoint, 'username'> & { username: string }) | null {
  const pattern = new RegExp(`<${element}\\s+type="${type}"[^>]*>([\\s\\S]*?)</${element}>`, 'i')
  const block = xml.match(pattern)?.[1]
  if (!block) return null

  const host = block.match(/<hostname>([^<]+)<\/hostname>/)?.[1]?.trim()
  const port = Number(block.match(/<port>(\d+)<\/port>/)?.[1])
  const socketType = block.match(/<socketType>([^<]+)<\/socketType>/)?.[1]?.trim()
  if (!host || !Number.isInteger(port)) return null

  return {
    host,
    port,
    security: toSecurity(socketType),
    username: block.match(/<username>([^<]+)<\/username>/)?.[1]?.trim() ?? '%EMAILADDRESS%'
  }
}

function toSecurity(socketType: string | undefined): EmailSocketSecurity {
  if (socketType === 'SSL') return 'tls'
  if (socketType === 'STARTTLS') return 'starttls'
  return 'plain'
}

/** ISPDB templates the username; only the two documented placeholders appear. */
function resolveUsername(template: string, address: string): string {
  if (template === '%EMAILADDRESS%') return address
  if (template === '%EMAILLOCALPART%') return address.slice(0, address.lastIndexOf('@'))
  return template
}
