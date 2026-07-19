import { describe, expect, it } from 'vitest'
import { buildDeterministicCheckpoint } from '../deterministicCheckpoint'

describe('buildDeterministicCheckpoint', () => {
  it('retains exact tool and artifact identifiers without invoking a model', async () => {
    const checkpoint = await buildDeterministicCheckpoint(
      '[called fetch_url({"url":"https://example.com"}) → Source artifact: artifact_123]'
    )
    expect(checkpoint).toContain('fetch_url')
    expect(checkpoint).toContain('https://example.com')
    expect(checkpoint).toContain('artifact_123')
  })

  it('never collapses a non-empty fold to an empty summary', async () => {
    const checkpoint = await buildDeterministicCheckpoint('useful finding')
    expect(checkpoint.trim().length).toBeGreaterThan(20)
  })

  it('deduplicates entries across replacement-style folds', async () => {
    const first = await buildDeterministicCheckpoint('same evidence')
    const second = await buildDeterministicCheckpoint('same evidence', first)
    expect(second.match(/same evidence/g)).toHaveLength(1)
  })
})
