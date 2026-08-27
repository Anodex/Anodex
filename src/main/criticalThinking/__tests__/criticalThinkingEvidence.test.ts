import { describe, expect, it } from 'vitest'
import type { CriticalThinkingSource } from '@shared/criticalThinking.types'
import type { ToolArtifact, WebFetchArtifact } from '@shared/toolArtifacts.types'
import {
  buildEvidencePacket,
  normalizeCitationMarkers,
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
    expect(packet).toContain('Evidence class: unclassified')
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
    expect(validation.issues).toContain(
      'Numeric claim 99 percent is not present in its cited evidence.'
    )
  })

  it('does not trust a verified source flag without matching fetched passages', () => {
    const validation = validateResearchReport('A material supported claim [[S1]].', [], sources)

    expect(validation.valid).toBe(false)
    expect(validation.issues).toContain('Citation S1 has no fetched evidence passages.')
  })

  it('classifies fabrication as a safety issue but a coverage gap as not', () => {
    const fabrication = validateResearchReport(
      'The result was 99 percent [[S1:P9]].',
      artifacts,
      sources
    )
    // A citation to a non-existent passage and a number absent from evidence
    // are fabrication — they must appear in safetyIssues.
    expect(fabrication.safetyIssues).toContain('Unknown evidence passage S1:P9.')
    expect(fabrication.safetyIssues).toContain(
      'Numeric claim 99 percent is not present in its cited evidence.'
    )

    const coverageOnly = validateResearchReport(
      'Supported finding [[S1:P1]].\n\nAn uncited framing sentence with no numbers here.',
      artifacts,
      sources
    )
    // An uncited prose block is a coverage gap, not fabrication.
    expect(coverageOnly.valid).toBe(false)
    expect(coverageOnly.safetyIssues).toEqual([])
    expect(coverageOnly.issues.some((issue) => issue.includes('no evidence citation'))).toBe(true)
  })

  it('flags weak-source-only substantive claims as a repairable coverage issue', () => {
    const weakSource: CriticalThinkingSource = {
      id: 'S1',
      title: 'General encyclopedia',
      url: 'https://en.wikipedia.org/wiki/Example',
      verified: true
    }
    const weakArtifact: ToolArtifact = {
      ...primaryFetch,
      requestedUrl: weakSource.url,
      finalUrl: weakSource.url,
      title: weakSource.title
    }
    const validation = validateResearchReport(
      'The central clinical comparison relies on this general reference alone for its conclusion [[S1:P1]].',
      [weakArtifact],
      [weakSource]
    )

    expect(validation.valid).toBe(false)
    expect(validation.safetyIssues).toEqual([])
    expect(validation.issues.some((issue) => issue.includes('general-reference'))).toBe(true)
  })

  it('does not flag outline/section numbering as an uncited numeric claim', () => {
    const validation = validateResearchReport(
      '## 1.1 Honey Bee Venom\n\n**2.3 Yellowjacket Venom**\n\nSupported finding [[S1:P1]].',
      artifacts,
      sources
    )
    expect(validation.issues.some((issue) => /Numeric claim 1\.1/.test(issue))).toBe(false)
    expect(validation.issues.some((issue) => /Numeric claim 2\.3/.test(issue))).toBe(false)
  })

  it('rejects uncited material paragraphs and uncited numeric claims', () => {
    const validation = validateResearchReport(
      'Supported finding [[S1:P1]].\n\nA fabricated uncited conclusion claims 77 percent growth.',
      artifacts,
      sources
    )

    expect(validation.valid).toBe(false)
    expect(validation.issues.some((issue) => issue.includes('no evidence citation'))).toBe(true)
    expect(validation.issues).toContain('Numeric claim 77 percent has no evidence citation.')
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
    expect(validation).toEqual({
      valid: true,
      issues: [],
      safetyIssues: [],
      unverifiedQuotationText: []
    })
  })

  it('requires an exact quote to appear in the source cited beside it', () => {
    const secondSource: CriticalThinkingSource = {
      id: 'S2',
      title: 'Independent interview',
      url: 'https://independent.example/interview',
      verified: true
    }
    const secondArtifact: ToolArtifact = {
      ...primaryFetch,
      id: 'artifact_2',
      requestedUrl: secondSource.url,
      finalUrl: secondSource.url,
      passages: [
        {
          id: 'P1',
          text: 'The interview stated, “This distinct quotation belongs only to source two.”',
          score: 100
        }
      ]
    }
    const validation = validateResearchReport(
      '“This distinct quotation belongs only to source two.” [[S1:P1]]',
      [...artifacts, secondArtifact],
      [...sources, secondSource]
    )

    expect(validation.valid).toBe(false)
    expect(validation.issues.some((issue) => issue.includes('its cited fetched passages'))).toBe(
      true
    )
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
    expect(earlierValidation).toEqual({
      valid: true,
      issues: [],
      safetyIssues: [],
      unverifiedQuotationText: []
    })
    expect(laterValidation).toEqual({
      valid: true,
      issues: [],
      safetyIssues: [],
      unverifiedQuotationText: []
    })
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
    ).toEqual({ valid: true, issues: [], safetyIssues: [], unverifiedQuotationText: [] })
    expect(
      validateResearchReport(
        'The study enrolled 100 participants [[S1:P1]].',
        [participantArtifact],
        sources
      ).valid
    ).toBe(false)
  })

  it('preserves percentage semantics when validating quantitative claims', () => {
    const countArtifact: ToolArtifact = {
      ...primaryFetch,
      passages: [{ id: 'P1', text: 'The study observed 5 patients in the cohort.', score: 100 }]
    }
    const percentArtifact: ToolArtifact = {
      ...primaryFetch,
      passages: [{ id: 'P1', text: 'The measured rate was 5 percent.', score: 100 }]
    }

    expect(
      validateResearchReport('The rate was 5% [[S1:P1]].', [countArtifact], sources).valid
    ).toBe(false)
    expect(
      validateResearchReport('The rate was 5% [[S1:P1]].', [percentArtifact], sources)
    ).toEqual({ valid: true, issues: [], safetyIssues: [], unverifiedQuotationText: [] })
  })

  it('recognizes exact decimals when HTML table cells collapse against labels', () => {
    const collapsedTableArtifact: ToolArtifact = {
      ...primaryFetch,
      passages: [
        {
          id: 'P1',
          text: 'SpeciesInsect TypeLD50 (mg/kg)Toxicity LevelP. infuscatus (paper wasp)Social Wasp1.3Most toxic venomP. metricusSocial Wasp1.5High toxicityV. mandariniaHornet2.8Lower toxicity',
          score: 100
        }
      ]
    }

    expect(
      validateResearchReport(
        'The cited table reports LD50 values of 1.3, 1.5, and 2.8 mg/kg [[S1:P1]].',
        [collapsedTableArtifact],
        sources
      )
    ).toEqual({ valid: true, issues: [], safetyIssues: [], unverifiedQuotationText: [] })
  })

  it('requires chart blocks to match the renderer grammar and cite their values', () => {
    const validChart = `\`\`\`chart
{"type":"bar","title":"Measured improvement","labels":["A","B"],"datasets":[{"label":"Rate","values":[18,18]}],"unit":"%","source":"[[S1:P1]]"}
\`\`\``
    const invalidChart = `\`\`\`chart
{"type":"pie","source":"[[S1:P1]]"}
\`\`\``

    expect(
      validateResearchReport(`Supported finding [[S1:P1]].\n\n${validChart}`, artifacts, sources)
    ).toEqual({ valid: true, issues: [], safetyIssues: [], unverifiedQuotationText: [] })
    expect(
      validateResearchReport(`Supported finding [[S1:P1]].\n\n${invalidChart}`, artifacts, sources)
        .issues
    ).toContain('A chart block does not match the supported chart schema.')

    const countArtifact: ToolArtifact = {
      ...primaryFetch,
      passages: [{ id: 'P1', text: 'The comparison included 18 patients.', score: 100 }]
    }
    expect(
      validateResearchReport(
        `Supported finding [[S1:P1]].\n\n${validChart}`,
        [countArtifact],
        sources
      ).issues.some((issue) => issue.includes('same unit'))
    ).toBe(true)
  })

  it('treats microgram spellings and symbols as the same chart unit', () => {
    const doseArtifact: ToolArtifact = {
      ...primaryFetch,
      passages: [
        {
          id: 'P1',
          text: 'The measured venom amounts were 59 micrograms and 10 micrograms.',
          score: 100
        }
      ]
    }
    const chart = `\`\`\`chart
{"type":"bar","title":"Venom amount","labels":["Bee","Wasp"],"datasets":[{"label":"Amount","values":[59,10]}],"unit":"μg","source":"[[S1:P1]]"}
\`\`\``

    expect(validateResearchReport(chart, [doseArtifact], sources)).toEqual({
      valid: true,
      issues: [],
      safetyIssues: [],
      unverifiedQuotationText: []
    })
  })

  it('accepts a bare figure whose evidence carries the unit, so ranges survive', () => {
    // "82-93%" is the ordinary way to write a percentage range and yields a
    // bare first claim; the evidence stating "82% to 93%" must satisfy it.
    const rangeSources: CriticalThinkingSource[] = [
      { id: 'S1', title: 'Rates', url: 'https://example.com/rates', verified: true }
    ]
    const rangeArtifacts: ToolArtifact[] = [
      {
        ...artifacts[0],
        requestedUrl: 'https://example.com/rates',
        finalUrl: 'https://example.com/rates',
        passages: [
          {
            id: 'P1',
            text: 'Sensitization rates of 82% to 93% were observed in sting patients.'
          }
        ]
      } as ToolArtifact
    ]
    const result = validateResearchReport(
      'Sensitization ran 82-93% across cohorts [[S1:P1]].',
      rangeArtifacts,
      rangeSources
    )
    expect(result.safetyIssues).toEqual([])
  })

  it('still rejects a claim that invents a unit the evidence never gave', () => {
    const bareSources: CriticalThinkingSource[] = [
      { id: 'S1', title: 'Counts', url: 'https://example.com/counts', verified: true }
    ]
    const bareArtifacts: ToolArtifact[] = [
      {
        ...artifacts[0],
        requestedUrl: 'https://example.com/counts',
        finalUrl: 'https://example.com/counts',
        passages: [{ id: 'P1', text: 'The cohort included 82 participants overall.' }]
      } as ToolArtifact
    ]
    const result = validateResearchReport(
      'Response reached 82% of the cohort [[S1:P1]].',
      bareArtifacts,
      bareSources
    )
    expect(result.safetyIssues.join(' ')).toContain('82%')
  })

  it('renders only known validated markers, as numbered references', () => {
    // A report with no Sources heading of its own gets the reference list its
    // numbers refer to appended, so [1] is never a bare number with no legend.
    expect(renderResearchCitations('Supported [[S1:P1]].', sources)).toBe(
      [
        'Supported [1](https://example.com/study).',
        '',
        '## Sources',
        '',
        '1. [Primary study](https://example.com/study)',
        ''
      ].join('\n')
    )
    // An unusable source resolves to no number, so there is nothing to list.
    expect(
      renderResearchCitations('Unsafe [[S9]].', [
        { id: 'S9', title: 'Unsafe source', url: 'javascript:alert(1)', verified: true }
      ])
    ).toBe('Unsafe [[S9]].')
  })

  it('reuses one number for a source however many times it is cited', () => {
    const twoSources: CriticalThinkingSource[] = [
      ...sources,
      { id: 'S2', title: 'Second study', url: 'https://example.com/second', verified: true }
    ]
    const rendered = renderResearchCitations(
      'First [[S1]]. Second [[S2:P3]]. First again [[S1:P9]].',
      twoSources
    )
    expect(rendered).toContain(
      'First [1](https://example.com/study). Second [2](https://example.com/second). ' +
        'First again [1](https://example.com/study).'
    )
    // Each source is listed once, under the number the prose gave it.
    expect(rendered).toContain('1. [Primary study](https://example.com/study)')
    expect(rendered).toContain('2. [Second study](https://example.com/second)')
  })

  it('numbers by first appearance in the prose, not by source id', () => {
    const twoSources: CriticalThinkingSource[] = [
      ...sources,
      { id: 'S2', title: 'Second study', url: 'https://example.com/second', verified: true }
    ]
    const rendered = renderResearchCitations('Later source first [[S2]], then [[S1]].', twoSources)
    expect(rendered).toContain('[1](https://example.com/second)')
    expect(rendered).toContain('[2](https://example.com/study)')
  })

  it('replaces the report’s Sources section with a numbered reference list', () => {
    const twoSources: CriticalThinkingSource[] = [
      ...sources,
      { id: 'S2', title: 'Second study', url: 'https://example.com/second', verified: true }
    ]
    const report = [
      '## Findings',
      '',
      'A claim [[S1]] and another [[S2]].',
      '',
      '## Sources',
      '',
      '[[S1]] [[S2]]',
      '',
      '## Conclusion',
      '',
      'Done.'
    ].join('\n')
    const rendered = renderResearchCitations(report, twoSources)

    expect(rendered).toContain('1. [Primary study](https://example.com/study)')
    expect(rendered).toContain('2. [Second study](https://example.com/second)')
    // The section is not the last one; what follows it must survive.
    expect(rendered).toContain('## Conclusion')
    expect(rendered.trimEnd().endsWith('Done.')).toBe(true)
    // The bare markers that used to sit in that section are gone.
    expect(rendered).not.toContain('[[S1]] [[S2]]')
  })

  it('says so plainly when a report cites nothing verifiable', () => {
    const report = '## Findings\n\nNo citations here.\n\n## Sources\n\n[[S404]]\n'
    expect(renderResearchCitations(report, sources)).toContain('No verified sources were cited.')
  })

  it('sanitizes source titles and rewrites chart citations without corrupting JSON', () => {
    const unsafeSources: CriticalThinkingSource[] = [
      {
        ...sources[0],
        title: 'Study ](https://evil.example)[ "quoted" \\ title'
      }
    ]
    const chart = `\`\`\`chart
{"type":"bar","title":"Result","labels":["A","B"],"datasets":[{"label":"Rate","values":[18,18]}],"source":"[[S1:P1]]"}
\`\`\``
    const rendered = renderResearchCitations(`Finding [[S1:P1]].\n\n${chart}`, unsafeSources)
    const renderedChart = /```chart\s*([\s\S]*?)```/.exec(rendered)?.[1]

    // The inline citation, the chart's source caption, and the appended
    // Sources entry — all three built from the same sanitized title, so a
    // title carrying its own markdown link cannot smuggle one through any of
    // them.
    expect(rendered.match(/\]\(https?:/g)).toHaveLength(3)
    expect(rendered).not.toContain('](https://evil.example)')
    expect(rendered).toContain('## Sources')
    expect(() => {
      JSON.parse(renderedChart ?? '')
    }).not.toThrow()
    expect((JSON.parse(renderedChart ?? '{}') as { source?: string }).source).toContain(
      'https://example.com/study'
    )
  })

  it('balances bounded synthesis evidence across research steps', () => {
    const balancedSources: CriticalThinkingSource[] = [
      {
        id: 'S1',
        title: 'Step one A',
        url: 'https://one.example/a',
        verified: true
      },
      {
        id: 'S2',
        title: 'Step one B',
        url: 'https://one.example/b',
        verified: true
      },
      {
        id: 'S3',
        title: 'Step two',
        url: 'https://two.example/a',
        verified: true
      }
    ]
    const balancedArtifacts: ToolArtifact[] = balancedSources.map((source, index) => ({
      id: `artifact_${index + 1}`,
      conversationId: 'critical_test',
      messageId: `message_${index + 1}`,
      createdAt: index + 1,
      research: {
        stepId: index < 2 ? 'step_1' : 'step_2',
        roundId: 'round_1'
      },
      kind: 'web-fetch',
      requestedUrl: source.url,
      finalUrl: source.url,
      status: 200,
      contentType: 'text/html',
      title: source.title,
      contentHash: `hash_${index + 1}`,
      contentChars: 200,
      truncated: false,
      passages: [
        {
          id: 'P1',
          text: `Evidence from ${source.title} with enough detail to remain useful in synthesis.`,
          score: 100
        }
      ],
      warnings: []
    }))

    const packet = buildEvidencePacket(balancedArtifacts, balancedSources, 600)

    expect(packet.length).toBeLessThanOrEqual(600)
    expect(packet.indexOf('[S1]')).toBeLessThan(packet.indexOf('[S3]'))
    expect(packet.indexOf('[S3]')).toBeLessThan(packet.indexOf('[S2]'))
    expect(packet).toContain('[S1:P1]')
    expect(packet).toContain('[S3:P1]')
  })

  it('orders stronger sources first within each research step', () => {
    const authoritySources: CriticalThinkingSource[] = [
      {
        id: 'S1',
        title: 'General reference',
        url: 'https://example.com/reference',
        verified: true
      },
      {
        id: 'S2',
        title: 'Government clinical study',
        url: 'https://evidence.gov/study',
        verified: true
      }
    ]
    const authorityArtifacts: ToolArtifact[] = authoritySources.map((source, index) => ({
      ...primaryFetch,
      id: `authority_${index}`,
      requestedUrl: source.url,
      finalUrl: source.url,
      title: source.title,
      passages: [
        {
          id: 'P1',
          text: `Evidence retained from ${source.title} with enough detail for synthesis.`,
          score: 100
        }
      ],
      research: { stepId: 'same-step', roundId: 'round-1' }
    }))

    const packet = buildEvidencePacket(authorityArtifacts, authoritySources)

    expect(packet.indexOf('[S2]')).toBeLessThan(packet.indexOf('[S1]'))
  })

  it('keeps a small-context packet useful when many verified sources exist', () => {
    const manySources: CriticalThinkingSource[] = Array.from({ length: 36 }, (_, index) => ({
      id: `S${index + 1}`,
      title: `Verified source ${index + 1}`,
      url: `https://source-${index + 1}.example/evidence`,
      verified: true
    }))
    const manyArtifacts: ToolArtifact[] = manySources.map((source, index) => ({
      id: `artifact_many_${index + 1}`,
      conversationId: 'critical_test',
      messageId: `message_many_${index + 1}`,
      createdAt: index + 1,
      research: {
        stepId: `step_${(index % 3) + 1}`,
        roundId: `round_${Math.floor(index / 3) + 1}`
      },
      kind: 'web-fetch',
      requestedUrl: source.url,
      finalUrl: source.url,
      status: 200,
      contentType: 'text/html',
      title: source.title,
      contentHash: `hash_many_${index + 1}`,
      contentChars: 1_000,
      truncated: false,
      passages: [
        {
          id: 'P1',
          text: `Detailed evidence ${index + 1} ${'with bounded supporting context '.repeat(10)}`,
          score: 100
        }
      ],
      warnings: []
    }))

    const packet = buildEvidencePacket(manyArtifacts, manySources, 4_000)
    const includedSources = packet.match(/^\[S\d+\]/gm) ?? []

    expect(packet.length).toBeLessThanOrEqual(4_000)
    expect(includedSources.length).toBeGreaterThan(10)
    expect(packet).toContain('[S1:P1]')
    expect(packet).toContain('[S2:P1]')
    expect(packet).toContain('[S3:P1]')
  })
})

describe('compound citation markers', () => {
  it('expands ranges and lists into the single markers every validator recognizes', () => {
    // The live shape: a report cited [[S9:P1-S9:P2]]. It matched no marker
    // pattern, so it rendered literally, was never checked against fetched
    // evidence, and left its paragraph counting as uncited.
    expect(normalizeCitationMarkers('Claim [[S9:P1-S9:P2]].')).toBe('Claim [[S9:P1]] [[S9:P2]].')
    expect(normalizeCitationMarkers('Claim [[S9:P1-P3]].')).toBe('Claim [[S9:P1]] [[S9:P3]].')
    expect(normalizeCitationMarkers('Claim [[S1, S2]].')).toBe('Claim [[S1]] [[S2]].')
    expect(normalizeCitationMarkers('Claim [[S1:P1; S1:P2]].')).toBe('Claim [[S1:P1]] [[S1:P2]].')
  })

  it('leaves ordinary markers and unparseable ones untouched', () => {
    expect(normalizeCitationMarkers('Plain [[S1]] and [[S1:P2]].')).toBe(
      'Plain [[S1]] and [[S1:P2]].'
    )
    // Left visible as a defect rather than silently deleted.
    expect(normalizeCitationMarkers('Odd [[see the appendix]].')).toBe('Odd [[see the appendix]].')
  })

  it('makes a range citation reachable by the fabrication check', () => {
    // S9 does not exist in `sources`. Before normalization the range hid that
    // entirely — the one class of issue that must never pass silently.
    const report = normalizeCitationMarkers('The dashboard lists active permits [[S9:P1-S9:P2]].')
    const validation = validateResearchReport(report, artifacts, sources)

    expect(validation.safetyIssues.join(' ')).toContain('S9')
  })
})

describe('sections about what the evidence does not cover', () => {
  it('does not demand citations, or report numeric claims, for a limits section', () => {
    const report = [
      '## Findings',
      '',
      'The measured improvement was 18 percent [[S1:P1]].',
      '',
      '## Limits and Open Questions',
      '',
      '- Colorado DOT funding allocations for 2024-2026: research remained limited.',
      '- No source reported service-contract terms for any regional dealer.'
    ].join('\n')

    const validation = validateResearchReport(report, artifacts, sources)
    const text = validation.issues.join(' ')

    expect(text).not.toContain('has no evidence citation')
    expect(text).not.toContain('2024')
    // A findings section is still held to the same standard.
    const uncited = validateResearchReport(
      '## Findings\n\nThe rollout covered 2024 through 2026 across every region.',
      artifacts,
      sources
    )
    expect(uncited.issues.join(' ')).toContain('has no evidence citation')
  })
})

describe('criticalThinkingEvidence — a citation whose case or spacing slipped', () => {
  it('canonicalizes a lone marker so the validators can see it', () => {
    // Every regex downstream matches uppercase with no padding, and a single
    // marker used to return before reaching the normalizer's own loop.
    expect(normalizeCitationMarkers('claim [[s1]].')).toBe('claim [[S1]].')
    expect(normalizeCitationMarkers('claim [[ S1]].')).toBe('claim [[S1]].')
    expect(normalizeCitationMarkers('claim [[S1:p2]].')).toBe('claim [[S1:P2]].')
  })

  it('does not report a properly cited report as having no citations at all', () => {
    // The failure this prevents: one slipped character made the paragraph count
    // as UNCITED *and* triggered "the report contains no evidence citation
    // markers", pushing a correctly sourced draft toward the blunt fallback.
    const report = normalizeCitationMarkers(
      'Growth was strong across every measured region [[s1]].'
    )
    const result = validateResearchReport(report, artifacts, sources)

    expect(result.issues).toEqual([])
  })

  // Passes pre-fix. Guards the loosened normalizer from swallowing a genuinely
  // broken marker, which is meant to stay visible rather than be deleted.
  it('still leaves a marker it cannot parse alone, so the defect stays visible', () => {
    expect(normalizeCitationMarkers('see [[Note]].')).toBe('see [[Note]].')
    expect(normalizeCitationMarkers('see [[P3]].')).toBe('see [[P3]].')
  })
})

describe('criticalThinkingEvidence — a quote written across lines', () => {
  it('checks a quote spanning lines against the evidence like any other', () => {
    // Excluding newlines meant a fabricated block quote — the ordinary way to
    // present a quotation — was matched by nothing and checked against nothing.
    const report =
      'The study is clear [[S1]].\n\n> "Teams reported a total collapse\n> of every measured outcome."'
    const result = validateResearchReport(report, artifacts, sources)

    expect(
      result.safetyIssues.some((issue) => issue.startsWith('Quoted text is not present'))
    ).toBe(true)
  })

  // Passes pre-fix, but only because nothing was checked at all. It earns its
  // place now: with quotes matched across lines, the `>` each continuation line
  // carries would otherwise make every genuine block quote a fabrication.
  it('accepts a real quote that happens to wrap', () => {
    const report = 'The study is clear [[S1]].\n\n> "Teams reported\n> better focus."'
    const result = validateResearchReport(report, artifacts, sources)

    expect(result.safetyIssues).toEqual([])
  })

  it('still catches a fabricated quote on one line', () => {
    const report = 'The study is clear [[S1]]. "Teams reported a total collapse of everything."'
    const result = validateResearchReport(report, artifacts, sources)

    expect(
      result.safetyIssues.some((issue) => issue.startsWith('Quoted text is not present'))
    ).toBe(true)
  })
})

describe('criticalThinkingEvidence — a raw URL the run actually fetched', () => {
  it('does not call a link to fetched evidence a fabrication', () => {
    // `safetyIssues` means "a claim not backed by real fetched evidence", and
    // this branch has just established the opposite. Treating it as fabrication
    // discarded sound reports over a formatting preference.
    const result = validateResearchReport(
      'See https://example.com/study for the figure [[S1]].',
      artifacts,
      sources
    )

    expect(result.safetyIssues).toEqual([])
    expect(result.issues.some((issue) => issue.includes('instead of a raw URL'))).toBe(true)
  })

  it('still treats a link to something never fetched as a fabrication', () => {
    const result = validateResearchReport(
      'See https://invented.example/page for the figure [[S1]].',
      artifacts,
      sources
    )

    expect(result.safetyIssues.some((issue) => issue.startsWith('Raw URL is not backed'))).toBe(
      true
    )
  })
})

describe('criticalThinkingEvidence — how far a pulled-out quote may reach for its citation', () => {
  // Also passes pre-fix for the same empty reason as above; it is what stops
  // the new check demanding a marker inside every pulled-out quotation.
  it('lets a quotation inherit the citation of the sentence that introduced it', () => {
    const report = 'The study is clear [[S1]].\n\n> "Teams reported\n> better focus."'

    expect(validateResearchReport(report, artifacts, sources).safetyIssues).toEqual([])
  })

  it('does not let it reach past the block immediately before', () => {
    // Otherwise an uncited quotation anywhere in the report could borrow
    // evidence from an arbitrary distance and read as verified.
    const report =
      'The study is clear [[S1]].\n\nSome uncited commentary sits here in between.\n\n> "Teams reported\n> better focus."'
    const result = validateResearchReport(report, artifacts, sources)

    expect(
      result.safetyIssues.some((issue) => issue.startsWith('Quoted text is not present'))
    ).toBe(true)
  })
})

describe('criticalThinkingEvidence — quotation pairing', () => {
  it('does not treat the prose between two quotations as a quotation', () => {
    // A straight `"` opens and closes, so when a quotation fell under the
    // length floor its closing mark was free to open a match running to the
    // next quotation's opening one. The prose in between was then checked
    // against the sources, found absent, and reported as fabricated.
    // A real report lost 21 phantoms this way and was thrown out for them.
    const report =
      'The study is clear [[S1:P1]]. The toggle is "repel" here. ' +
      'I should soften this claim, because the task says "Teams reported better focus." now.'
    const result = validateResearchReport(report, artifacts, sources)

    expect(
      result.safetyIssues.filter((issue) => issue.startsWith('Quoted text is not present'))
    ).toEqual([])
  })

  it('still reports a quotation that is not in the evidence', () => {
    // The promise this module exists to keep. The pairing fix must not buy
    // quiet by checking less.
    const report = 'The study is clear [[S1:P1]]. "Teams reported a total collapse of output."'
    const result = validateResearchReport(report, artifacts, sources)

    expect(
      result.safetyIssues.some((issue) => issue.startsWith('Quoted text is not present'))
    ).toBe(true)
  })

  it('pairs curly quotation marks with their own closing mark', () => {
    const report = 'The study is clear [[S1:P1]]. “Teams reported better focus.” Nothing else.'
    const result = validateResearchReport(report, artifacts, sources)

    expect(result.safetyIssues).toEqual([])
  })

  it('ignores an unterminated quotation rather than inventing a span', () => {
    const report = 'The study is clear [[S1:P1]]. Then someone wrote "an opening mark and no close'
    const result = validateResearchReport(report, artifacts, sources)

    expect(
      result.safetyIssues.filter((issue) => issue.startsWith('Quoted text is not present'))
    ).toEqual([])
  })

  it('does not sweep citation markers or table pipes into a quotation', () => {
    // The shape seen in the real report: spans that began at one quotation's
    // closing mark ran through markdown table structure and citation markers.
    const report =
      'Findings [[S1:P1]]. A short "tag" follows.\n\n' +
      '| Feature | Evidence |\n| Lasers [[S1:P1]] | Marketed |\n\n' +
      'And then "Teams reported better focus." closes it.'
    const result = validateResearchReport(report, artifacts, sources)

    expect(
      result.safetyIssues.filter((issue) => issue.startsWith('Quoted text is not present'))
    ).toEqual([])
  })
})

describe('criticalThinkingEvidence — edited quotations', () => {
  it('accepts a quotation shortened with an ellipsis', () => {
    // Real report, faulted for this: "at first intimidating amount of… options".
    // The text was genuinely in the source; only the middle was left out.
    const report = 'Findings [[S1:P1]]. "The measured improvement… Teams reported better focus."'
    const result = validateResearchReport(report, artifacts, sources)

    expect(
      result.safetyIssues.filter((issue) => issue.startsWith('Quoted text is not present'))
    ).toEqual([])
  })

  it('accepts a word altered in brackets to fit the sentence', () => {
    // Real report, faulted for "freeze[s] the entire planet".
    const report = 'Findings [[S1:P1]]. "Team[s] reported better focus." Nothing else.'
    const result = validateResearchReport(report, artifacts, sources)

    expect(
      result.safetyIssues.filter((issue) => issue.startsWith('Quoted text is not present'))
    ).toEqual([])
  })

  it('will not let an ellipsis stitch a quotation out of order', () => {
    // The mark may shorten a quotation; it may not reorder the source.
    const report = 'Findings [[S1:P1]]. "Teams reported better focus… The measured improvement"'
    const result = validateResearchReport(report, artifacts, sources)

    expect(
      result.safetyIssues.some((issue) => issue.startsWith('Quoted text is not present'))
    ).toBe(true)
  })

  it('still reports a fabricated quotation that contains an ellipsis', () => {
    const report = 'Findings [[S1:P1]]. "Teams reported total collapse… of every measured outcome"'
    const result = validateResearchReport(report, artifacts, sources)

    expect(
      result.safetyIssues.some((issue) => issue.startsWith('Quoted text is not present'))
    ).toBe(true)
  })
})

describe('criticalThinkingEvidence — punctuation inside a quotation', () => {
  it('accepts a quotation carrying the comma its own sentence needed', () => {
    // English convention puts a comma inside the closing mark, so a quotation
    // ending a clause carries punctuation the source does not have. Observed
    // live on "dynamically responds to your window size," and two others in
    // one report.
    const report =
      'Findings [[S1:P1]]. As they put it, "Teams reported better focus," and moved on.'
    const result = validateResearchReport(report, artifacts, sources)

    expect(
      result.safetyIssues.filter((issue) => issue.startsWith('Quoted text is not present'))
    ).toEqual([])
  })

  it('still reports a quotation whose words differ from the source', () => {
    // Only trailing punctuation is forgiven. The text itself must match.
    const report = 'Findings [[S1:P1]]. They said "Teams reported total collapse of focus,"'
    const result = validateResearchReport(report, artifacts, sources)

    expect(
      result.safetyIssues.some((issue) => issue.startsWith('Quoted text is not present'))
    ).toBe(true)
  })

  it('does not forgive punctuation in the middle of a quotation', () => {
    const report = 'Findings [[S1:P1]]. They said "Teams, reported better focus."'
    const result = validateResearchReport(report, artifacts, sources)

    expect(
      result.safetyIssues.some((issue) => issue.startsWith('Quoted text is not present'))
    ).toBe(true)
  })
})

describe('criticalThinkingEvidence — a quotation cited to the wrong passage', () => {
  const twoPassages: ToolArtifact[] = [
    {
      ...(artifacts[0] as WebFetchArtifact),
      passages: [
        { id: 'P1', text: 'The measured improvement was 18 percent.', score: 100 },
        { id: 'P2', text: 'Teams reported better focus after the change.', score: 90 }
      ]
    }
  ]

  it('reports a misattributed quotation as coverage, not fabrication', () => {
    // Measured on a live report: 3 of 16 flagged quotations were real text on
    // the cited page under a different marker, and 13 were on no page at all.
    // Reporting both as fabrication buried the ones that were.
    const report = 'Findings [[S1:P1]]. They wrote "Teams reported better focus after the change."'
    const result = validateResearchReport(report, twoPassages, sources)

    expect(
      result.safetyIssues.filter((issue) => issue.startsWith('Quoted text is not present'))
    ).toEqual([])
    expect(result.issues.some((issue) => issue.startsWith('Quotation is on the cited page'))).toBe(
      true
    )
  })

  it('still calls it fabrication when the text is on no fetched page', () => {
    const report = 'Findings [[S1:P1]]. They wrote "a total collapse of every measured outcome."'
    const result = validateResearchReport(report, twoPassages, sources)

    expect(
      result.safetyIssues.some((issue) => issue.startsWith('Quoted text is not present'))
    ).toBe(true)
  })

  it('says nothing when the quotation matches the passage actually cited', () => {
    const report = 'Findings [[S1:P2]]. They wrote "Teams reported better focus after the change."'
    const result = validateResearchReport(report, twoPassages, sources)

    expect(result.safetyIssues).toEqual([])
    expect(result.issues.some((issue) => issue.startsWith('Quotation is on the cited page'))).toBe(
      false
    )
  })
})

describe('criticalThinkingEvidence — a figure cited to the wrong passage', () => {
  const twoPassages: ToolArtifact[] = [
    {
      ...(artifacts[0] as WebFetchArtifact),
      passages: [
        { id: 'P1', text: 'Teams reported better focus after the change.', score: 100 },
        { id: 'P2', text: 'In Fall 2011 the team hired two more developers.', score: 90 }
      ]
    }
  ]

  it('reports a misattributed figure as coverage, not fabrication', () => {
    // Measured on a live report: two years, both verbatim in the presskit the
    // run had fetched, were reported as fabrication because the marker pointed
    // at a different passage. That alone made the report unusable and sent the
    // run to its fallback.
    const report = 'The team grew in 2011 [[S1:P1]].'
    const result = validateResearchReport(report, twoPassages, sources)

    expect(result.safetyIssues).toEqual([])
    expect(
      result.issues.some((issue) => issue.startsWith('Numeric claim 2011 is on the cited page'))
    ).toBe(true)
  })

  it('still calls it fabrication when the figure is on no fetched page', () => {
    const report = 'The team grew in 2008 [[S1:P1]].'
    const result = validateResearchReport(report, twoPassages, sources)

    expect(
      result.safetyIssues.some((issue) =>
        issue.startsWith('Numeric claim 2008 is not present in its cited evidence')
      )
    ).toBe(true)
  })

  it('says nothing when the figure is in the passage actually cited', () => {
    const report = 'The team grew in 2011 [[S1:P2]].'
    const result = validateResearchReport(report, twoPassages, sources)

    expect(result.safetyIssues).toEqual([])
    expect(result.issues.some((issue) => issue.startsWith('Numeric claim'))).toBe(false)
  })
})
