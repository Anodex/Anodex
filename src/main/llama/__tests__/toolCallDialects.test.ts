import { describe, it, expect } from 'vitest'
import * as nlc from 'node-llama-cpp'
import { resolveToolCallingWrapper } from '../toolCallDialects'

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
