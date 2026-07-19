import { describe, expect, it } from 'vitest'
import type { CriticalThinkingSource } from '@shared/criticalThinking.types'
import type { ToolArtifact, WebFetchArtifact } from '@shared/toolArtifacts.types'
import {
  buildEvidencePacket,
  normalizeQuote,
  renderResearchCitations,
  validateResearchReport
} from '../criticalThinkingEvidence'

const sources: CriticalThinkingSource[] = [
  {
    id: 'S1',
    title: 'Primary study',
    url: 'https://example.com/study',
    verified: true
  }
]

const artifacts: ToolArtifact[] = [
  {
    id: 'artifact_1',
    conversationId: 'critical_test',
    messageId: 'message_1',
    createdAt: 1,
    kind: 'web-fetch',
    requestedUrl: 'https://example.com/study',
    finalUrl: 'https://example.com/study',
    status: 200,
    contentType: 'text/html',
    title: 'Primary study',
    contentHash: 'hash',
    contentChars: 200,
    truncated: false,
    passages: [
      {
        id: 'P1',
        text: 'The measured improvement was 18 percent. “Teams reported better focus.”',
        score: 100
      }
    ],
    warnings: []
  }
]
const primaryFetch = artifacts[0] as WebFetchArtifact

describe('Critical Thinking evidence pipeline', () => {
  it('builds a packet with exact source and passage ids', () => {
    const packet = buildEvidencePacket(artifacts, sources)
    expect(packet).toContain('[S1] Primary study')
    expect(packet).toContain('[S1:P1] The measured improvement')
  })

  it('never exceeds its caller-provided packet budget', () => {
    const packet = buildEvidencePacket(artifacts, sources, 100)
    expect(packet.length).toBeLessThanOrEqual(100)
    expect(packet).toContain('[S1:P1]')
  })

  it('rejects unknown citations and model-authored raw URLs', () => {
    const validation = validateResearchReport(
      'A claim [[S9]]. See https://invented.example/report.',
      artifacts,
      sources
    )
    expect(validation.valid).toBe(false)
    expect(validation.issues.join(' ')).toContain('Unknown')
    expect(validation.issues.join(' ')).toContain('not backed')
  })

  it('rejects unknown passages and unsupported numeric claims', () => {
    const validation = validateResearchReport(
      'The result was 99 percent [[S1:P9]].',
      artifacts,
      sources
    )
    expect(validation.valid).toBe(false)
    expect(validation.issues).toContain('Unknown evidence passage S1:P9.')
    expect(validation.issues).toContain('Numeric claim 99 is not present in its cited evidence.')
  })

  it('normalizes smart quotes, non-breaking spaces, and whitespace for quote checks', () => {
    expect(normalizeQuote('“Teams\u00a0reported   better focus.”')).toBe(
      '"teams reported better focus."'
    )
    const validation = validateResearchReport(
      '# Report\n\n“Teams reported better focus.” [[S1:P1]]',
      artifacts,
      sources
    )
    expect(validation).toEqual({ valid: true, issues: [] })
  })

  it('validates passages across repeated focused fetches of the same URL', () => {
    const laterFetch: ToolArtifact = {
      ...primaryFetch,
      id: 'artifact_2',
      passages: [{ id: 'P1', text: 'A later focused fetch found a separate result.', score: 90 }]
    }
    const repeatedArtifacts = [...artifacts, laterFetch]
    const packet = buildEvidencePacket(repeatedArtifacts, sources)
    const earlierValidation = validateResearchReport(
      'The measured improvement was 18 percent [[S1:P1]].',
      repeatedArtifacts,
      sources
    )
    const laterValidation = validateResearchReport(
      'A separate result was found [[S1:P2]].',
      repeatedArtifacts,
      sources
    )

    expect(packet).toContain('[S1:P1] The measured improvement')
    expect(packet).toContain('[S1:P2] A later focused fetch')
    expect(earlierValidation).toEqual({ valid: true, issues: [] })
    expect(laterValidation).toEqual({ valid: true, issues: [] })
  })

  it('matches equivalent numeric formatting without substring false positives', () => {
    const participantArtifact: ToolArtifact = {
      ...primaryFetch,
      passages: [{ id: 'P1', text: 'The study enrolled 1000 participants.', score: 100 }]
    }
    expect(
      validateResearchReport(
        'The study enrolled 1,000 participants [[S1:P1]].',
        [participantArtifact],
        sources
      )
    ).toEqual({ valid: true, issues: [] })
    expect(
      validateResearchReport(
        'The study enrolled 100 participants [[S1:P1]].',
        [participantArtifact],
        sources
      ).valid
    ).toBe(false)
  })

  it('renders only known validated markers as deterministic Markdown links', () => {
    expect(renderResearchCitations('Supported [[S1:P1]].', sources)).toBe(
      'Supported [Primary study](https://example.com/study).'
    )
  })
})
