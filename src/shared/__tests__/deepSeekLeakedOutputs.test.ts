import { describe, it, expect } from 'vitest'
import { stripLeakedEngineText, findPotentialToolCallTextStart } from '../toolCallText'
import {
  DEEPSEEK_CALL_BEGIN,
  DEEPSEEK_OUTPUTS_BEGIN,
  DEEPSEEK_OUTPUTS_END,
  DEEPSEEK_OUTPUT_BEGIN,
  DEEPSEEK_OUTPUT_END
} from '../deepSeekMarkers'

describe('fabricated tool outputs in visible text', () => {
  it('drops an invented result block, content and all', () => {
    // Taken from a live reply: the model opened its turn by echoing two file
    // ranges back as though they were results it had received.
    const text =
      `${DEEPSEEK_OUTPUTS_BEGIN}${DEEPSEEK_OUTPUT_BEGIN}{"path": "js/universe-sandbox.js", "startLine": 1, "endLine": 40}${DEEPSEEK_OUTPUT_END}\n` +
      `${DEEPSEEK_OUTPUT_BEGIN}{"path": "js/universe-sandbox.js", "startLine": 41, "endLine": 966}${DEEPSEEK_OUTPUT_END}${DEEPSEEK_OUTPUTS_END}\n` +
      ' I will continue from where I left off.'

    expect(stripLeakedEngineText(text)).toBe('I will continue from where I left off.')
  })

  it('drops an unterminated block rather than leaving the worst case on screen', () => {
    const text = `Reading it now.\n${DEEPSEEK_OUTPUTS_BEGIN}${DEEPSEEK_OUTPUT_BEGIN}{"lines": ["invented"]}`
    expect(stripLeakedEngineText(text)).toBe('Reading it now.')
  })

  it('removes a stray marker without eating the prose around it', () => {
    const text = `Done.${DEEPSEEK_OUTPUTS_END}\nThe imports are global now.`
    expect(stripLeakedEngineText(text)).toBe('Done.\nThe imports are global now.')
  })

  it('leaves ordinary text alone', () => {
    const text = 'I read the file and it still uses ES module imports.'
    expect(stripLeakedEngineText(text)).toBe(text)
  })

  it('holds a marker back while streaming', () => {
    expect(findPotentialToolCallTextStart(`I'll read it.\n${DEEPSEEK_CALL_BEGIN}`)).toBe(14)
    expect(findPotentialToolCallTextStart(`Here you go.${DEEPSEEK_OUTPUTS_BEGIN}`)).toBe(12)
  })
})
