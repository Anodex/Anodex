import { describe, expect, it, vi } from 'vitest'
import type { GenerateParams } from '../LlamaService'
import type { ToolFunction } from '../../tools/types'
import {
  RESERVED_TOKENS,
  minimumViableOutputTokens,
  visionSchemaCeilingTokens
} from '../LlamaVisionService'

// The tool registry reaches the whole service graph, including one module that
// builds a LlamaService at import time. None of it is involved in arithmetic
// over token counts, so it is stubbed rather than constructed.
vi.mock('../../tools/registry', () => ({
  buildToolFunctions: () => ({}),
  toolRegistry: {}
}))

/**
 * The ceiling that stopped 4096 being a dead window on the vision transport.
 *
 * `minDirectTools` admits the builder loop without consulting the budget. At
 * 4096 the loop's ten schemas measured 2,086 tokens against a 3,584 input
 * limit, so the fixed input passed the limit before any reply was reserved and
 * all twelve turns of a run returned zero characters.
 *
 * These pin the arithmetic rather than the model behaviour, because the
 * arithmetic is what failed: the gate is
 * `inputLimit - (system + prompt + schemas) >= minimumOutput`, and the ceiling
 * is that inequality solved for schemas.
 */

/** Roughly the compact chat prompt, which is about 44% of a 4096 window. */
const SYSTEM_PROMPT = 'x'.repeat(1_802 * 4)
const USER_PROMPT = 'y'.repeat(200 * 4)

/** What the ten-tool builder loop measured at, in this transport's own units. */
const BUILDER_LOOP_SCHEMA_TOKENS = 2_086

const params = (overrides: Partial<GenerateParams> = {}): GenerateParams =>
  ({ systemPrompt: SYSTEM_PROMPT, prompt: USER_PROMPT, ...overrides }) as GenerateParams

const surface = (names: string[]): Record<string, ToolFunction> =>
  Object.fromEntries(names.map((name) => [name, {} as ToolFunction]))

/** A surface that can make a bounded write, so it is charged the 1,280 floor. */
const PROJECT_TOOLS = surface(['write_file', 'read_file_range', 'run_command', 'finish_goal'])
/** Chat: web, email and status, none of which can emit a large payload. */
const CHAT_TOOLS = surface(['web_search', 'fetch_url', 'anodex_status'])

describe('visionSchemaCeilingTokens', () => {
  it('binds at 4096, where the builder loop cannot fit at any price', () => {
    const ceiling = visionSchemaCeilingTokens(4096, PROJECT_TOOLS, params())

    expect(ceiling).toBeLessThan(BUILDER_LOOP_SCHEMA_TOKENS)
  })

  it('does not bind at 8192, so a window that works today is unchanged', () => {
    // The whole risk of this change. A share of the input limit could not do
    // both: not binding at 8K needs at least 2,086/7,680 = 0.272, and fixing 4K
    // needs at most about 0.251. Anchoring on the measured prompt has no such
    // conflict, and this is the assertion that says so.
    const ceiling = visionSchemaCeilingTokens(8192, PROJECT_TOOLS, params())

    expect(ceiling).toBeGreaterThan(BUILDER_LOOP_SCHEMA_TOKENS)
  })

  it('leaves the turn able to generate, which is the point', () => {
    // Restate the gate itself: spending the whole ceiling on schemas must still
    // clear `fitsNow`, or the ceiling has not bought anything.
    for (const contextSize of [4096, 8192, 16384, 32768]) {
      const ceiling = visionSchemaCeilingTokens(contextSize, PROJECT_TOOLS, params())
      const fixed = 1_802 + 200 + ceiling
      const inputLimit = contextSize - RESERVED_TOKENS
      const minimumOutput = minimumViableOutputTokens(contextSize, true)

      expect(inputLimit - fixed).toBeGreaterThanOrEqual(minimumOutput)
    }
  })

  it('gives a chat surface more room than a project one at the same window', () => {
    // A surface that cannot write is not charged the bounded-write floor, so at
    // 4096 it keeps a workable set of tools where a builder surface cannot.
    const chat = visionSchemaCeilingTokens(4096, CHAT_TOOLS, params())
    const project = visionSchemaCeilingTokens(4096, PROJECT_TOOLS, params())

    expect(chat).toBeGreaterThan(project)
  })

  it('tightens as the system prompt grows, rather than assuming a fixed one', () => {
    const short = visionSchemaCeilingTokens(8192, PROJECT_TOOLS, params({ systemPrompt: 'short' }))
    const long = visionSchemaCeilingTokens(8192, PROJECT_TOOLS, params())

    expect(short).toBeGreaterThan(long)
  })

  it('never goes negative, however little room is left', () => {
    const ceiling = visionSchemaCeilingTokens(
      2048,
      PROJECT_TOOLS,
      params({ systemPrompt: 'z'.repeat(100_000) })
    )

    expect(ceiling).toBe(0)
  })

  it('imposes no ceiling when there are no tools to bound', () => {
    expect(visionSchemaCeilingTokens(4096, undefined, params())).toBe(Number.POSITIVE_INFINITY)
    expect(visionSchemaCeilingTokens(4096, {}, params())).toBe(Number.POSITIVE_INFINITY)
  })
})
