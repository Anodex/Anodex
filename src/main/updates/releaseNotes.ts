import { err, ok, type Result } from '@shared/result'
import type { ReleaseNotes } from '@shared/update.types'

const RELEASE_API_BASE = 'https://api.github.com/repos/Anodex/Anodex/releases/tags'
const RELEASE_PAGE_BASE = 'https://github.com/Anodex/Anodex/releases/tag'
const FETCH_TIMEOUT_MS = 12_000
const MAX_RESPONSE_BYTES = 256 * 1024
const MAX_BODY_CHARS = 100_000
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/

/** Fetch only this installed version's public release, with bounded network input. */
export async function fetchReleaseNotes(
  version: string,
  fetcher: typeof fetch = fetch
): Promise<Result<ReleaseNotes>> {
  if (!VERSION_PATTERN.test(version)) {
    return err('updates.invalid-version', 'Could not identify this Anodex version.')
  }

  const tag = `v${version}`
  try {
    const response = await fetcher(`${RELEASE_API_BASE}/${encodeURIComponent(tag)}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Anodex-Desktop'
      }
    })
    if (response.status === 404) {
      return err(
        'updates.release-not-found',
        'Release notes for this version are not published yet.'
      )
    }
    if (!response.ok) {
      return err('updates.release-unavailable', 'Could not load release notes from GitHub.')
    }

    const bytes = await readBoundedResponse(response)
    const release: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (!release || typeof release !== 'object' || !('tag_name' in release)) {
      return err('updates.release-invalid', 'GitHub returned invalid release notes.')
    }
    const record = release as Record<string, unknown>
    if (record.tag_name !== tag || typeof record.body !== 'string') {
      return err('updates.release-invalid', 'GitHub returned notes for a different release.')
    }

    return ok({
      version,
      title: typeof record.name === 'string' && record.name.trim() ? record.name : tag,
      body: record.body.slice(0, MAX_BODY_CHARS),
      publishedAt: typeof record.published_at === 'string' ? record.published_at : null,
      url: `${RELEASE_PAGE_BASE}/${encodeURIComponent(tag)}`
    })
  } catch {
    return err('updates.release-unavailable', 'Could not load release notes from GitHub.')
  }
}

async function readBoundedResponse(response: Response): Promise<Uint8Array> {
  if (!response.body) throw new Error('Missing release response body')
  const reader: ReadableStreamDefaultReader<Uint8Array> = (
    response.body as ReadableStream<Uint8Array>
  ).getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error('Release response is too large')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
