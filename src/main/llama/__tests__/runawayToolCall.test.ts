import { describe, expect, it } from 'vitest'
import { RunawayToolCallWatch } from '../runawayToolCall'

// Stand in for each model's tokenizer, with what the real ones were measured to
// read as a single token. Everything else is several.
const GEMMA_4 = new Set(['<tool_call|>', '<|tool_call>', '<|channel>', '<channel|>', '<|turn>'])
const LLAMA_3 = new Set(['<|eot_id|>', '<|python_tag|>', '<|start_header_id|>'])
const oneTokenIn =
  (vocabulary: Set<string>) =>
  (marker: string): boolean =>
    vocabulary.has(marker)

describe('the runaway tool call watch', () => {
  it("flags the arguments Gemma wrote after a path's backslash swallowed its closing quote", () => {
    const watch = new RunawayToolCallWatch(oneTokenIn(GEMMA_4))
    expect(watch.observe(0, '{"check": "disk", "name": "C:\\",')).toBe(false)
    expect(watch.observe(0, '"port": 0,"path": "/}}<tool_call|>')).toBe(true)
  })

  it('sees a marker split across two chunks', () => {
    const watch = new RunawayToolCallWatch(oneTokenIn(GEMMA_4))
    expect(watch.observe(0, '{"path": "C:\\" }<|chan')).toBe(false)
    expect(watch.observe(0, 'nel>thought')).toBe(true)
  })

  it("reads each model's own markers, not another's", () => {
    const llama = new RunawayToolCallWatch(oneTokenIn(LLAMA_3))
    expect(llama.observe(0, '{"q": "budget<tool_call|><|channel>')).toBe(false)
    expect(llama.observe(1, '{"q": "budget"}<|eot_id|>')).toBe(true)
  })

  it('leaves ordinary arguments, and another template written into a file, alone', () => {
    const watch = new RunawayToolCallWatch(oneTokenIn(GEMMA_4))
    expect(watch.observe(0, '{"path": "prompt.txt", "content": "<|im_start|>user\\n')).toBe(false)
    expect(watch.observe(0, 'hello<|im_end|> and <b>bold</b> | a<|b"}')).toBe(false)
  })

  it('keeps each call apart', () => {
    const watch = new RunawayToolCallWatch(oneTokenIn(GEMMA_4))
    expect(watch.observe(0, '{"q": "<|chan')).toBe(false)
    expect(watch.observe(1, 'nel>"}')).toBe(false)
  })
})
