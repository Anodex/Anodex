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
    expect(validation).toEqual({ valid: true, issues: [], safetyIssues: [] })
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
    expect(earlierValidation).toEqual({ valid: true, issues: [], safetyIssues: [] })
    expect(laterValidation).toEqual({ valid: true, issues: [], safetyIssues: [] })
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
    ).toEqual({ valid: true, issues: [], safetyIssues: [] })
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
    ).toEqual({ valid: true, issues: [], safetyIssues: [] })
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
    ).toEqual({ valid: true, issues: [], safetyIssues: [] })
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
    ).toEqual({ valid: true, issues: [], safetyIssues: [] })
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
      safetyIssues: []
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
    expect(renderResearchCitations('Supported [[S1:P1]].', sources)).toBe(
      'Supported [1](https://example.com/study).'
    )
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
    expect(rendered).toBe(
      'First [1](https://example.com/study). Second [2](https://example.com/second). ' +
        'First again [1](https://example.com/study).'
    )
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

    expect(rendered.match(/\]\(https?:/g)).toHaveLength(2)
    expect(rendered).not.toContain('](https://evil.example)')
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
