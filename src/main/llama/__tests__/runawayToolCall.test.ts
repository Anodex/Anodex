import { describe, expect, it } from 'vitest'
import { RunawayToolCallWatch, salvageArguments } from '../runawayToolCall'

// Stand in for each model's tokenizer, with what the real ones were measured to
// read as a single token. Everything else is several.
const GEMMA_4 = new Set(['<tool_call|>', '<|tool_call>', '<|channel>', '<channel|>', '<|turn>'])
const LLAMA_3 = new Set(['<|eot_id|>', '<|python_tag|>', '<|start_header_id|>'])
const oneTokenIn =
  (vocabulary: Set<string>) =>
  (marker: string): boolean =>
    vocabulary.has(marker)

describe('the runaway tool call watch', () => {
  it('returns what the call wrote before the marker, once one appears', () => {
    const watch = new RunawayToolCallWatch(oneTokenIn(GEMMA_4))
    expect(watch.observe(0, '{"check": "disk", "name": "C:\\",')).toBeNull()
    expect(watch.observe(0, '"port": 0,"path": "/}}<tool_call|><|channel>thought')).toBe(
      '{"check": "disk", "name": "C:\\","port": 0,"path": "/}}'
    )
  })

  it('sees a marker split across two chunks', () => {
    const watch = new RunawayToolCallWatch(oneTokenIn(GEMMA_4))
    expect(watch.observe(0, '{"path": "C:/" }<|chan')).toBeNull()
    expect(watch.observe(0, 'nel>thought')).toBe('{"path": "C:/" }')
  })

  it("reads each model's own markers, not another's", () => {
    const llama = new RunawayToolCallWatch(oneTokenIn(LLAMA_3))
    expect(llama.observe(0, '{"q": "budget<tool_call|><|channel>')).toBeNull()
    expect(llama.observe(1, '{"q": "budget"}<|eot_id|>')).toBe('{"q": "budget"}')
  })

  it('leaves ordinary arguments, and another template written into a file, alone', () => {
    const watch = new RunawayToolCallWatch(oneTokenIn(GEMMA_4))
    expect(watch.observe(0, '{"path": "prompt.txt", "content": "<|im_start|>user\n')).toBeNull()
    expect(watch.observe(0, 'hello<|im_end|> and <b>bold</b> | a<|b"}')).toBeNull()
  })

  it('keeps each call apart', () => {
    const watch = new RunawayToolCallWatch(oneTokenIn(GEMMA_4))
    expect(watch.observe(0, '{"q": "<|chan')).toBeNull()
    expect(watch.observe(1, 'nel>"}')).toBeNull()
  })

  // Llama 3.1 8B on "What does my todo list say?", for 15 minutes.
  it('flags a run of one short piece, with no marker at all, and keeps one piece of it', () => {
    const watch = new RunawayToolCallWatch(oneTokenIn(LLAMA_3))
    const start = '{"check": "disk", "name": "todo list", "port": 0, "path": "C:'
    expect(watch.observe(0, start)).toBeNull()
    let written: string | null = null
    for (let i = 0; i < 400 && written === null; i++) written = watch.observe(0, '\\\\')
    expect(written).toBe(`${start}\\`)
  })

  it('leaves a short run, and long text that does not repeat, alone', () => {
    const watch = new RunawayToolCallWatch(oneTokenIn(LLAMA_3))
    expect(watch.observe(0, `{"content": "${'='.repeat(200)}`)).toBeNull()
    const prose = Array.from({ length: 80 }, (_, i) => `line ${i} of the notes`).join('\\n')
    expect(watch.observe(1, `{"content": "${prose}`)).toBeNull()
  })
})

const CHECK_COMPUTER = {
  type: 'object',
  properties: {
    check: { enum: ['program', 'port', 'disk', 'system'] },
    name: { type: 'string' },
    port: { type: 'number' },
    path: { type: 'string' }
  },
  required: ['check']
}

describe('reading back the call a runaway meant', () => {
  // Both written by Gemma 4 E4B on "How much free disk space do I have?".
  it('closes a string the model never closed', () => {
    expect(salvageArguments('{"check": "disk", "path": "/}}', CHECK_COMPUTER)).toEqual({
      check: 'disk',
      path: '/'
    })
  })

  it('reads a backslash before the closing quote as a character', () => {
    expect(
      salvageArguments('{"check": "disk", "name": "C:\\","port": 0,"path": "/}}', CHECK_COMPUTER)
    ).toEqual({ check: 'disk', name: 'C:\\', port: 0, path: '/' })
  })

  it('closes a string that a run left ending on a lone backslash', () => {
    expect(
      salvageArguments(
        '{"check": "disk", "name": "todo list", "port": 0, "path": "C:\\',
        CHECK_COMPUTER
      )
    ).toEqual({ check: 'disk', name: 'todo list', port: 0, path: 'C:\\' })
  })

  it('takes an object that was already whole', () => {
    expect(salvageArguments('{"check": "system"}', CHECK_COMPUTER)).toEqual({ check: 'system' })
  })

  it('guesses nothing the tool would not accept', () => {
    // A value the tool does not allow, a field it does not have, and one it requires missing.
    expect(salvageArguments('{"check": "everything"}', CHECK_COMPUTER)).toBeNull()
    expect(salvageArguments('{"check": "disk", "drive": "C', CHECK_COMPUTER)).toBeNull()
    expect(salvageArguments('{"path": "/', CHECK_COMPUTER)).toBeNull()
    expect(salvageArguments('{"check": "di', CHECK_COMPUTER)).toBeNull()
    expect(salvageArguments('', CHECK_COMPUTER)).toBeNull()
  })
})
