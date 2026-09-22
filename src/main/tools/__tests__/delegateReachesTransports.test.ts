import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every transport must forward the `delegate` capability into `buildTools`.
 *
 * This is a source-level check because the bug it guards cannot be caught any
 * other way that is cheaper. Five files call `buildTools`, each rebuilding
 * the tool context field by field from its own params, and the registry
 * decides whether to register `delegate` purely from whether that field
 * arrived. Omit the line in one transport and sub-agents are silently off for
 * that provider — no error, no warning, and every unit test still passes
 * because they all construct the context directly.
 *
 * That is not hypothetical. It shipped: `LlamaService` never forwarded it, so
 * on the local engine the tool was registered nowhere. A 27B was told to split
 * its work across sub-agents and answered "no delegate tool is visible in my
 * current toolset", twice, while `canDelegate` logged true and the run's own
 * tool set listed `delegate`. Three arms of a benchmark measured the baseline
 * under another name before it surfaced.
 *
 * TypeScript could not catch it either: `runGeneration` assigns its tools
 * object to a `const` before passing it, which switches off excess-property
 * checking, so a field missing from the shared params type was dropped in
 * silence rather than rejected.
 */

const ROOT = join(import.meta.dirname, '..', '..', '..', '..', 'src', 'main')

/** Every file that builds a tool context for a provider. */
const TRANSPORTS = [
  'llama/LlamaService.ts',
  'llama/LlamaVisionService.ts',
  'llm/AnthropicProvider.ts',
  'llm/OpenAiProvider.ts',
  'llm/OpenAiCompatibleProvider.ts'
]

function source(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8')
}

describe('the delegate capability reaches every transport', () => {
  it.each(TRANSPORTS)('%s forwards delegate into buildTools', (relative) => {
    const text = source(relative)
    expect(text).toContain('buildTools(')
    expect(text).toContain('delegate: params.tools.delegate')
  })

  it('finds every buildTools call site, so none is missed as the list grows', () => {
    // If a sixth transport appears, this fails and whoever added it has to
    // decide whether sub-agents work there — rather than finding out from a
    // model that says the tool does not exist.
    const found = TRANSPORTS.filter((relative) => source(relative).includes('buildTools('))
    expect(found).toHaveLength(TRANSPORTS.length)
  })

  it('declares the capability on the shared params type', () => {
    // Where it was missing. Without the declaration the transports cannot
    // forward it even if they try, and the `const` assignment in
    // `runGeneration` means nothing complains.
    expect(source('llama/LlamaService.ts')).toMatch(/delegate\?: DelegateCapability/)
  })

  it('still supplies it from runGeneration', () => {
    // The other end of the same wire.
    expect(source('chat/runGeneration.ts')).toContain('delegate: io.delegate')
  })
})
