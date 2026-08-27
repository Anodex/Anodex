import { describe, expect, it } from 'vitest'
import {
  criticalThinkingSourceAuthorityScore,
  criticalThinkingSourceClass,
  isWeakCriticalThinkingSource
} from '../criticalThinkingSourceAuthority'

describe('Critical Thinking source authority', () => {
  it('classifies download portals as commercial regardless of subject', () => {
    // Observed live: a research run cited softonic.com for a factual claim
    // about a commercial game. Aggregators carry no original reporting.
    expect(criticalThinkingSourceClass('https://softonic.com/windows/x')).toBe('commercial')
    expect(criticalThinkingSourceClass('https://universe-sandbox.en.softonic.com/')).toBe(
      'commercial'
    )
    expect(criticalThinkingSourceClass('https://en.uptodown.com/windows/app')).toBe('commercial')
    expect(isWeakCriticalThinkingSource('https://apkpure.com/app')).toBe(true)
  })

  it('ranks an aggregator below a vendor page for the same subject', () => {
    // The bug this guards: both scored 0, so the ranker could not tell the
    // primary source from a page that republishes it wrapped in ads.
    const aggregator = criticalThinkingSourceAuthorityScore(
      'https://universe-sandbox.en.softonic.com/'
    )
    const vendor = criticalThinkingSourceAuthorityScore('https://universesandbox.com/presskit')
    expect(aggregator).toBeLessThan(vendor)
  })

  it('does not mistake ordinary hosts that merely contain a portal name', () => {
    // The pattern is anchored to a host label, so these must stay unaffected.
    expect(criticalThinkingSourceClass('https://softonically.example.com/a')).not.toBe('commercial')
    expect(criticalThinkingSourceClass('https://store.steampowered.com/app/72200')).not.toBe(
      'commercial'
    )
    expect(criticalThinkingSourceClass('https://en.wikipedia.org/wiki/X')).toBe('general-reference')
    expect(criticalThinkingSourceClass('https://nasa.gov/page')).toBe('official')
  })
})
