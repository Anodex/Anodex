import { describe, expect, it } from 'vitest'
import * as nlc from 'node-llama-cpp'
import { DIRECT_ANSWER_BUDGETS, DIRECT_ANSWER_TEMPLATE_KWARGS } from '../directAnswer'

/**
 * These pin down *why* each backend gets the lever it does, because the two
 * are not interchangeable and the wrong one is silently inert — which is how
 * a reasoning model came to answer every inbox digest with truncated
 * scratchpad while the code read as though thinking had been turned off.
 *
 * Run against REAL node-llama-cpp wrappers: they are pure-JS classes, so no
 * native binding or model is loaded, and unlike fakes they can actually
 * disagree with what the code assumes about them.
 */

/**
 * The generation-prompt tail of a Qwen3-family template: thinking is opened
 * unless `enable_thinking` is explicitly false. Trimmed to the branch under
 * test — the real Qwen3.6-27B template wraps this same conditional in ~8k
 * characters of vision and tool-call handling.
 */
const QWEN_STYLE_TEMPLATE = [
  '{%- for message in messages %}',
  "{{- '<|im_start|>' + message.role + '\\n' + message.content + '<|im_end|>\\n' }}",
  '{%- endfor %}',
  '{%- if add_generation_prompt %}',
  "{{- '<|im_start|>assistant\\n' }}",
  '{%- if enable_thinking is defined and enable_thinking is false %}',
  "{{- '<think>\\n\\n</think>\\n\\n' }}",
  '{%- else %}',
  "{{- '<think>\\n' }}",
  '{%- endif %}',
  '{%- endif %}'
].join('\n')

function renderPrompt(wrapper: nlc.ChatWrapper): string {
  const { contextText } = wrapper.generateContextState({
    chatHistory: [
      { type: 'system', text: 'You are helpful.' },
      { type: 'user', text: 'Summarize this thread.' },
      { type: 'model', response: [] }
    ]
  })
  return contextText.toString()
}

describe('DIRECT_ANSWER_TEMPLATE_KWARGS', () => {
  // llama-server hands this straight to the model's own Jinja template.
  // Verified against the bundled binary with the real Qwen3.6-27B template:
  // the prompt ends `<think>\n` without it, `<think>\n\n</think>\n\n` with it.
  it('asks the template to skip thinking', () => {
    expect(DIRECT_ANSWER_TEMPLATE_KWARGS).toEqual({ enable_thinking: false })
  })
})

describe('DIRECT_ANSWER_BUDGETS', () => {
  it('leaves a thought segment no room to run', () => {
    expect(DIRECT_ANSWER_BUDGETS).toEqual({ thoughtTokens: 0 })
  })

  /**
   * The reason the budget exists rather than reusing the template variable on
   * this backend. node-llama-cpp lifts a template's `<think>` prefill out of
   * the rendered prompt and into its own thought-segment definition, so both
   * renderings arrive at the model identically and `enable_thinking` buys
   * nothing here. If a future node-llama-cpp stops normalizing the two, this
   * fails and the cheaper lever becomes available again.
   */
  it('is needed because the template variable does not change what node-llama-cpp sends', () => {
    const thinking = new nlc.JinjaTemplateChatWrapper({ template: QWEN_STYLE_TEMPLATE })
    const asked = new nlc.JinjaTemplateChatWrapper({
      template: QWEN_STYLE_TEMPLATE,
      additionalRenderParameters: { enable_thinking: false }
    })

    expect(renderPrompt(asked)).toBe(renderPrompt(thinking))
    expect(renderPrompt(thinking)).not.toContain('</think>')
    // Thinking has not gone away — it has moved somewhere the budget governs.
    expect(thinking.settings.segments?.thought).toBeDefined()
  })

  /**
   * The wrapper the built-in `thoughts: 'discourage'` prefill covers, and the
   * one it does not. Both emit thought segments, so both are governed by the
   * budget — which is the whole point of preferring it.
   */
  it('governs both the wrapper with a built-in lever and the one without', () => {
    expect(new nlc.QwenChatWrapper().settings.segments?.thought).toBeDefined()
    expect(
      new nlc.JinjaTemplateChatWrapper({ template: QWEN_STYLE_TEMPLATE }).settings.segments?.thought
    ).toBeDefined()
  })
})
