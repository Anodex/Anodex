import { describe, it, expect } from 'vitest'
import * as nlc from 'node-llama-cpp'
import { buildDeepSeekChatWrapper } from '../deepSeekWrapper'
import {
  DEEPSEEK_CALLS_BEGIN,
  DEEPSEEK_CALLS_END,
  DEEPSEEK_CALL_BEGIN,
  DEEPSEEK_CALL_END,
  DEEPSEEK_OUTPUTS_BEGIN,
  DEEPSEEK_OUTPUTS_END,
  DEEPSEEK_OUTPUT_BEGIN,
  DEEPSEEK_OUTPUT_END,
  DEEPSEEK_SEP
} from '../deepSeekMarkers'

/** Enough of DeepSeek's chat template for the wrapper to render a prompt. */
const TEMPLATE = `{% for message in messages %}{{ message['role'] }}: {{ message['content'] }}\n{% endfor %}`

function settings() {
  const wrapper = buildDeepSeekChatWrapper(nlc, TEMPLATE)
  const functions = wrapper.settings.functions
  if (functions == null) throw new Error('expected function-calling settings')
  return functions
}

describe('DeepSeek chat wrapper', () => {
  it('matches a call on the per-call marker alone, not the section opener', () => {
    const { call } = settings()

    // The regression: with the section opener folded into the call prefix, only
    // the first call of a section is ever recognised.
    expect(call.prefix).not.toContain(DEEPSEEK_CALLS_BEGIN)
    expect(String(call.prefix)).toContain(DEEPSEEK_CALL_BEGIN)
    expect(String(call.prefix)).toContain(DEEPSEEK_SEP)
    expect(String(call.suffix)).toContain(DEEPSEEK_CALL_END)
    expect(String(call.suffix)).not.toContain(DEEPSEEK_CALLS_END)
  })

  it('declares the call and result sections so a finished call closes cleanly', () => {
    const { parallelism } = settings()

    expect(parallelism?.call).toMatchObject({
      sectionPrefix: DEEPSEEK_CALLS_BEGIN,
      betweenCalls: '',
      sectionSuffix: DEEPSEEK_CALLS_END
    })
    expect(parallelism?.result).toMatchObject({
      sectionPrefix: DEEPSEEK_OUTPUTS_BEGIN,
      sectionSuffix: DEEPSEEK_OUTPUTS_END
    })
  })

  it('keeps one result marker per result, not the whole section each time', () => {
    const { result } = settings()

    expect(String(result.prefix)).toContain(DEEPSEEK_OUTPUT_BEGIN)
    expect(String(result.prefix)).not.toContain(DEEPSEEK_OUTPUTS_BEGIN)
    expect(String(result.suffix)).toContain(DEEPSEEK_OUTPUT_END)
    expect(String(result.suffix)).not.toContain(DEEPSEEK_OUTPUTS_END)
  })

  it('is still a working Jinja wrapper built on the model’s own template', () => {
    const wrapper = buildDeepSeekChatWrapper(nlc, TEMPLATE)
    expect(wrapper).toBeInstanceOf(nlc.JinjaTemplateChatWrapper)
    expect(wrapper.settings.functions?.call.paramsPrefix).toBeTruthy()
  })
})
