#!/usr/bin/env node
/**
 * Check every cloud provider's base URL actually exists, without using a key.
 *
 * Usage: node scripts/provider-endpoints.mjs
 *
 * A base URL is the one part of a provider integration that cannot be checked
 * by reading it — every one of them "looks right", and a wrong host or a
 * missing path segment only shows up when a user with a real key gets an error
 * that blames their key. Anodex ships a provider list most users will never
 * configure more than one entry of, so a typo can sit unnoticed indefinitely.
 *
 * Azure OpenAI is deliberately absent: its base URL is the customer's own
 * resource name, so there is nothing shipped to check.
 *
 * The probe sends an unauthenticated chat-completions request. What comes back
 * separates the cases cleanly:
 *
 *   401 / 403  the endpoint is there and wants credentials  -> URL is right
 *   400 / 422  reached the API, it disliked the empty body   -> URL is right
 *   404        wrong path
 *   ENOTFOUND  wrong host
 *
 * No API key is read, sent, or needed. The request carries no credentials at
 * all, which is exactly why a 401 is the pass condition.
 */
import { readFileSync } from 'node:fs'
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'

const source = readFileSync('src/main/llm/cloudProviderConfigs.ts', 'utf-8')

/**
 * Read the base URLs out of the config rather than restating them here.
 * A checker with its own copy of the values it is checking proves nothing.
 */
const providers = [
  ...source.matchAll(
    /id: '([a-z]+)',\s*\n\s*displayName: '([^']+)',(?:\s*\n\s*\/\/[^\n]*)*\s*\n\s*baseURL: '([^']+)'/g
  )
].map(([, id, displayName, baseURL]) => ({
  id,
  displayName,
  baseURL,
  probePath: '/chat/completions'
}))

if (providers.length === 0) {
  console.error('No providers parsed — cloudProviderConfigs.ts may have changed shape.')
  process.exit(2)
}

/**
 * Anthropic and OpenAI are not in that config: they use their own SDK clients,
 * which carry the base URL as a built-in default. Those two are the providers
 * most users will actually reach for, so leaving them out would check the nine
 * that rarely get configured and skip the two that always do.
 *
 * Instantiating the client to read `.baseURL` keeps the rule the rest of this
 * script follows — read the value under test, never restate it. The throwaway
 * key is never sent; constructing a client performs no request.
 */
providers.push(
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    baseURL: new Anthropic({ apiKey: 'not-a-key' }).baseURL,
    // Anthropic is not OpenAI-shaped; its endpoint is /v1/messages.
    probePath: '/v1/messages'
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    baseURL: new OpenAI({ apiKey: 'not-a-key' }).baseURL,
    probePath: '/chat/completions'
  }
)

const results = []
for (const provider of providers) {
  const url = `${provider.baseURL.replace(/\/$/, '')}${provider.probePath}`
  let verdict
  let detail
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(15_000)
    })
    detail = String(response.status)
    if ([401, 403].includes(response.status)) verdict = 'REACHABLE (wants auth)'
    else if ([400, 422].includes(response.status)) verdict = 'REACHABLE (rejected empty body)'
    else if (response.status === 404) verdict = 'WRONG PATH'
    else verdict = `unexpected ${response.status}`
  } catch (error) {
    const code = error?.cause?.code ?? error?.name ?? 'unknown'
    detail = String(code)
    verdict = code === 'ENOTFOUND' ? 'WRONG HOST' : `unreachable (${code})`
  }
  results.push({ ...provider, verdict, detail })
  console.log(
    `  ${provider.displayName.padEnd(14)} ${provider.baseURL.padEnd(58)} ${verdict} [${detail}]`
  )
}

const bad = results.filter((r) => !r.verdict.startsWith('REACHABLE'))
console.log(`\n${results.length - bad.length}/${results.length} endpoints reachable`)
if (bad.length) {
  console.log('needs attention:')
  for (const entry of bad) console.log(`  ${entry.displayName}: ${entry.verdict} (${entry.detail})`)
}
process.exit(bad.length === 0 ? 0 : 1)
