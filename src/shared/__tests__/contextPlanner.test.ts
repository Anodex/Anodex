import { describe, expect, it } from 'vitest'
import { automaticReferenceContextChars } from '../contextBudget'
import {
  assembleAutomaticReferenceContext,
  automaticReferenceAllowanceChars,
  capacityReport,
  charsPerToken,
  normalizeContextAssemblyStrategy,
  type AutomaticReferenceSource
} from '../contextPlanner'

/** A source whose units are individually large enough to compete for room. */
const units = (char: string, count: number, size = 600): string[] =>
  Array.from({ length: count }, (_, index) => `${index}-${char.repeat(size)}`)

const sources = (overrides: Partial<Record<string, string[]>> = {}): AutomaticReferenceSource[] => [
  { id: 'workspace', units: overrides.workspace ?? units('w', 4), separator: '\n\n' },
  { id: 'memory', units: overrides.memory ?? units('m', 4) },
  { id: 'transcript-recall', units: overrides['transcript-recall'] ?? units('r', 4) }
]

describe('automaticReferenceAllowanceChars', () => {
  it('gives back nothing once the fixed prompt has outgrown the window', () => {
    // The recorded 4K failure: fixed instructions and tool schemas needed 2,658
    // tokens of a window that could not seat them and a reply as well.
    expect(
      automaticReferenceAllowanceChars({
        contextWindowTokens: 4_096,
        fixedPromptTokens: 1_929,
        toolSchemaTokens: 729
      })
    ).toBe(0)
  })

  it('never exceeds the window reference cap when there is plenty of room', () => {
    const allowance = automaticReferenceAllowanceChars({
      contextWindowTokens: 128_000,
      fixedPromptTokens: 2_000,
      toolSchemaTokens: 1_000
    })
    expect(allowance).toBe(automaticReferenceContextChars(128_000))
  })

  it('shrinks as the fixed prompt grows, on a window where the cap does not bind', () => {
    const roomy = automaticReferenceAllowanceChars({
      contextWindowTokens: 8_192,
      fixedPromptTokens: 1_000,
      toolSchemaTokens: 500
    })
    const crowded = automaticReferenceAllowanceChars({
      contextWindowTokens: 8_192,
      fixedPromptTokens: 2_469,
      toolSchemaTokens: 1_242
    })
    expect(crowded).toBeLessThan(roomy)
    expect(crowded).toBeGreaterThan(0)
  })
})

describe('charsPerToken', () => {
  it('falls back to the fixed approximation with nothing measured', () => {
    expect(charsPerToken(undefined)).toBe(4)
    expect(charsPerToken(null)).toBe(4)
  })

  it('uses a transport-measured ratio', () => {
    // The measured 8K batch: 7,794 rendered characters counted as 2,533 tokens.
    expect(charsPerToken({ chars: 7_794, tokens: 2_533 })).toBeCloseTo(3.08, 2)
  })

  it('ignores a degenerate or impossible report rather than scaling by it', () => {
    expect(charsPerToken({ chars: 0, tokens: 100 })).toBe(4)
    expect(charsPerToken({ chars: 100, tokens: 0 })).toBe(4)
    // Above the fixed ratio would *widen* the budget on an unverified number.
    expect(charsPerToken({ chars: 9_000, tokens: 100 })).toBe(4)
    // Below one character per token is not a tokenizer, it is a bad report.
    expect(charsPerToken({ chars: 50, tokens: 100 })).toBe(4)
  })
})

describe('automaticReferenceAllowanceChars — calibration', () => {
  it('shrinks the allowance once the real token density is known', () => {
    const input = { contextWindowTokens: 8_192, fixedPromptTokens: 1_200, toolSchemaTokens: 1_474 }
    const assumed = automaticReferenceAllowanceChars(input)
    const measured = automaticReferenceAllowanceChars({
      ...input,
      calibration: { chars: 7_794, tokens: 2_533 }
    })
    expect(measured).toBeLessThan(assumed)
  })

  it('records which ratio a plan used', () => {
    const uncalibrated = capacityReport({
      contextWindowTokens: 8_192,
      fixedPromptTokens: 1_200,
      toolSchemaTokens: 1_474
    })
    expect(uncalibrated.calibrated).toBe(false)
    expect(uncalibrated.charsPerToken).toBe(4)

    const calibrated = capacityReport({
      contextWindowTokens: 8_192,
      fixedPromptTokens: 1_200,
      toolSchemaTokens: 1_474,
      calibration: { chars: 7_794, tokens: 2_533 }
    })
    expect(calibrated.calibrated).toBe(true)
    expect(calibrated.charsPerToken).toBeCloseTo(3.08, 2)
  })
})

describe('assembleAutomaticReferenceContext', () => {
  it('keeps the current projection byte-for-byte unchanged', () => {
    const assembly = assembleAutomaticReferenceContext({
      strategy: 'current',
      contextWindowTokens: 2_048,
      fixedPromptTokens: 4_000,
      toolSchemaTokens: 800,
      sources: [
        // Trailing whitespace included deliberately: `current` is the rollback
        // path, so it must render what the retrievers hand it and nothing else.
        { id: 'workspace', units: ['Workspace facts\n', ''], separator: '\n\n' },
        { id: 'memory', units: ['Remembered fact'] },
        { id: 'transcript-recall', units: ['Past chat excerpt'] }
      ]
    })

    expect(assembly.texts).toEqual({
      workspace: 'Workspace facts\n',
      memory: 'Remembered fact',
      'transcript-recall': 'Past chat excerpt'
    })
    expect(assembly.report.automaticReferenceBudgetChars).toBeNull()
    expect(assembly.report.capacity).toBeUndefined()
    expect(assembly.report.sources.every((source) => source.selection === 'current')).toBe(true)
  })

  it('never splits a unit — every included source is a prefix of what it offered', () => {
    const offered = sources()
    const assembly = assembleAutomaticReferenceContext({
      strategy: 'adaptive-v1',
      contextWindowTokens: 8_192,
      fixedPromptTokens: 1_200,
      toolSchemaTokens: 600,
      sources: offered
    })

    for (const source of offered) {
      const included = assembly.includedUnits[source.id]
      const expected = source.units.slice(0, included).join(source.separator ?? '\n')
      expect(assembly.texts[source.id] ?? '').toBe(expected)
    }
  })

  it('stays within the allowance it planned', () => {
    const assembly = assembleAutomaticReferenceContext({
      strategy: 'adaptive-v1',
      contextWindowTokens: 8_192,
      fixedPromptTokens: 1_200,
      toolSchemaTokens: 600,
      sources: sources()
    })

    expect(assembly.report.automaticReferenceIncludedChars).toBeLessThanOrEqual(
      assembly.report.automaticReferenceBudgetChars!
    )
    expect(assembly.report.automaticReferenceOmittedChars).toBeGreaterThan(0)
  })

  it('lets every source contribute when the window can afford them all', () => {
    const assembly = assembleAutomaticReferenceContext({
      strategy: 'adaptive-v1',
      contextWindowTokens: 128_000,
      fixedPromptTokens: 1_000,
      toolSchemaTokens: 500,
      sources: sources({ workspace: ['small'], memory: ['fact'], 'transcript-recall': ['excerpt'] })
    })

    expect(assembly.report.sources.every((source) => source.selection === 'allocated')).toBe(true)
    expect(assembly.report.automaticReferenceOmittedChars).toBe(0)
  })

  it('defers every source when the window has nothing left to give', () => {
    const assembly = assembleAutomaticReferenceContext({
      strategy: 'adaptive-v1',
      contextWindowTokens: 4_096,
      fixedPromptTokens: 1_929,
      toolSchemaTokens: 729,
      sources: sources()
    })

    expect(assembly.report.automaticReferenceBudgetChars).toBe(0)
    expect(assembly.report.automaticReferenceIncludedChars).toBe(0)
    expect(assembly.texts).toEqual({ workspace: null, memory: null, 'transcript-recall': null })
    expect(assembly.report.sources.every((source) => source.selection === 'deferred')).toBe(true)
    expect(assembly.includedUnits).toEqual({ workspace: 0, memory: 0, 'transcript-recall': 0 })
  })

  it('hands an unused share to the sources that can use it', () => {
    const assembly = assembleAutomaticReferenceContext({
      strategy: 'adaptive-v1',
      contextWindowTokens: 128_000,
      fixedPromptTokens: 1_000,
      toolSchemaTokens: 500,
      sources: sources({ memory: ['one short remembered fact'] })
    })

    const workspace = assembly.report.sources.find((source) => source.id === 'workspace')!
    const memory = assembly.report.sources.find((source) => source.id === 'memory')!
    expect(memory.selection).toBe('allocated')
    // An equal third of the cap seats two 600-character units and no more, so
    // anything beyond that came out of memory's unspent share.
    expect(workspace.includedUnits).toBeGreaterThan(2)
  })

  it('reports units, not just characters, so provenance can be sliced from it', () => {
    const assembly = assembleAutomaticReferenceContext({
      strategy: 'adaptive-v1',
      contextWindowTokens: 8_192,
      fixedPromptTokens: 1_200,
      toolSchemaTokens: 600,
      sources: sources()
    })

    for (const source of assembly.report.sources) {
      expect(source.includedUnits).toBeLessThanOrEqual(source.availableUnits)
      if (source.includedUnits < source.availableUnits) {
        expect(source.selection === 'partial' || source.selection === 'deferred').toBe(true)
      }
    }
  })

  it('spends the allowance instead of stranding it behind one large unit', () => {
    // The measured 8K regression: an allowance of 3,372 with a two-unit
    // workspace (975 + 1,424) and three small recall blocks. Reserving an equal
    // share per source committed workspace to its first unit, recall packed all
    // three of its blocks, and the 1,258 characters left over were then too few
    // for the block workspace still wanted — 2,114 of 3,372 spent, with the
    // larger source losing to the smaller purely because its pieces were bigger.
    const assembly = assembleAutomaticReferenceContext({
      strategy: 'adaptive-v1',
      contextWindowTokens: 8_192,
      fixedPromptTokens: 1_700,
      toolSchemaTokens: 1_474,
      sources: [
        { id: 'workspace', units: ['w'.repeat(975), 'a'.repeat(1_422)] },
        { id: 'memory', units: [] },
        { id: 'transcript-recall', units: ['r'.repeat(378), 'r'.repeat(378), 'r'.repeat(378)] }
      ]
    })

    const workspace = assembly.report.sources.find((source) => source.id === 'workspace')!
    // The whole workspace survives, which is the point: it is the orientation a
    // task acts from, and it lost to lexical matches from other conversations.
    expect(workspace.includedUnits).toBe(2)
    expect(assembly.report.automaticReferenceIncludedChars).toBeGreaterThan(2_114)
    expect(assembly.report.automaticReferenceIncludedChars).toBeLessThanOrEqual(
      assembly.report.automaticReferenceBudgetChars!
    )
  })

  it('still gives every source its first unit before anyone gets a second', () => {
    // The guarantee that stops a single greedy sweep letting workspace take the
    // lot: recall must not be silenced just because it is ranked last.
    const assembly = assembleAutomaticReferenceContext({
      strategy: 'adaptive-v1',
      contextWindowTokens: 8_192,
      fixedPromptTokens: 1_700,
      toolSchemaTokens: 1_474,
      sources: [
        { id: 'workspace', units: ['w'.repeat(1_200), 'w'.repeat(1_200)] },
        { id: 'memory', units: ['m'.repeat(600)] },
        { id: 'transcript-recall', units: ['r'.repeat(600)] }
      ]
    })

    for (const source of assembly.report.sources) {
      if (source.availableUnits > 0) expect(source.includedUnits).toBeGreaterThanOrEqual(1)
    }
  })

  it('falls back to current behavior when capacity is not factual yet', () => {
    const assembly = assembleAutomaticReferenceContext({
      strategy: 'adaptive-v1',
      contextWindowTokens: undefined,
      fixedPromptTokens: 1_200,
      toolSchemaTokens: 600,
      sources: [
        { id: 'workspace', units: ['Workspace facts'] },
        { id: 'memory', units: [] },
        { id: 'transcript-recall', units: [] }
      ]
    })

    expect(assembly.texts.workspace).toBe('Workspace facts')
    expect(assembly.report.automaticReferenceBudgetChars).toBeNull()
    expect(assembly.report.capacity).toBeUndefined()
  })
})

describe('normalizeContextAssemblyStrategy', () => {
  it('uses the current path for absent or unrecognized persisted values', () => {
    expect(normalizeContextAssemblyStrategy(undefined)).toBe('current')
    expect(normalizeContextAssemblyStrategy('future-v2')).toBe('current')
    expect(normalizeContextAssemblyStrategy('adaptive-v1')).toBe('adaptive-v1')
  })
})
