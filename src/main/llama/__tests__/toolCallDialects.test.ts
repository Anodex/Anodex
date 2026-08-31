import { describe, it, expect } from 'vitest'
import * as nlc from 'node-llama-cpp'
import { resolveToolCallingWrapper, fabricatedResultStopTriggers } from '../toolCallDialects'

const TEMPLATE = `{% for message in messages %}{{ message['role'] }}: {{ message['content'] }}\n{% endfor %}`

describe('resolveToolCallingWrapper', () => {
  it('leaves every unlisted architecture to node-llama-cpp', () => {
    // The table is an exception list, not a catalog — the library resolves a
    // wrapper from the GGUF correctly for most families, and overriding that
    // on a guess is how a working model gets broken.
    for (const architecture of ['llama', 'qwen3', 'gemma3', 'phi3', 'mistral', 'unknown-arch']) {
      expect(resolveToolCallingWrapper(nlc, architecture, TEMPLATE)).toBeUndefined()
    }
  })

  it('overrides every DeepSeek architecture revision', () => {
    // `deepseek2` is what DeepSeek-Coder-V2-Lite declares; matching on the
    // prefix keeps a later revision from silently losing its dialect.
    for (const architecture of ['deepseek', 'deepseek2', 'deepseek3', 'DeepSeek2']) {
      expect(resolveToolCallingWrapper(nlc, architecture, TEMPLATE)).toBeDefined()
    }
  })

  it('keeps the model’s own template when it has one', () => {
    const wrapper = resolveToolCallingWrapper(nlc, 'deepseek2', TEMPLATE)
    expect(wrapper).toBeInstanceOf(nlc.JinjaTemplateChatWrapper)
  })

  it('falls back to the purpose-built wrapper when the GGUF carries no template', () => {
    // Substituting it wholesale is only right here: it replaces the prompt too,
    // and with a template present that stopped the model calling tools at all.
    expect(resolveToolCallingWrapper(nlc, 'deepseek2', undefined)).toBeInstanceOf(
      nlc.DeepSeekChatWrapper
    )
    expect(resolveToolCallingWrapper(nlc, 'deepseek2', '')).toBeInstanceOf(nlc.DeepSeekChatWrapper)
  })

  it('resolves nothing without an architecture to key on', () => {
    expect(resolveToolCallingWrapper(nlc, undefined, TEMPLATE)).toBeUndefined()
    expect(resolveToolCallingWrapper(nlc, '', TEMPLATE)).toBeUndefined()
  })
})

describe('a model writing Anodex own tool-result marker', () => {
  /**
   * `LlamaService` continues a fallback-parsed call by writing
   * `Tool result for <name>:` into the prompt. That string is Anodex's, not the
   * model's, so a model producing it has begun inventing results by definition
   * — the same argument as DeepSeek's `tool_output_begin` token, applied to a
   * marker the harness emits for every model rather than one architecture.
   *
   * Measured: gemma-3-27b wrote it on 6 of 44 turns, inventing file contents
   * that did not match the workspace — a `unittest` import and a `Product`
   * class in a fixture that has neither. Across 571 turns of five other models
   * it never appeared once, so stopping on it costs nothing anywhere else.
   */
  it('is a stop trigger whatever the architecture', () => {
    for (const architecture of ['gemma', 'qwen2', 'llama', 'mistral', 'phi3']) {
      expect(fabricatedResultStopTriggers(architecture)).toContain('Tool result for ')
    }
  })

  it('keeps the architecture-specific markers alongside it', () => {
    const deepseek = fabricatedResultStopTriggers('deepseek2')

    expect(deepseek).toContain('Tool result for ')
    expect(deepseek.length).toBeGreaterThan(1)
  })

  // An unknown architecture still gets the harness marker: it is Anodex's
  // string, so it does not depend on knowing the model.
  it('applies even when the architecture is unknown', () => {
    expect(fabricatedResultStopTriggers('something-unheard-of')).toContain('Tool result for ')
  })

  it('says nothing when there is no architecture at all', () => {
    expect(fabricatedResultStopTriggers(undefined)).toEqual([])
    expect(fabricatedResultStopTriggers('')).toEqual([])
  })
})
