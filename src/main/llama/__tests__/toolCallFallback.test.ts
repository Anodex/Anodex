import { describe, expect, it } from 'vitest'
import {
  detectFallbackToolCall,
  findPotentialToolCallTextStart,
  stripFallbackCall
} from '../toolCallFallback'

const TOOLS = new Set(['read_file', 'write_file', 'list_directory'])

describe('detectFallbackToolCall', () => {
  it('detects a call wrapped in <tool_call> tags', () => {
    const text =
      '<tool_call>\n{"name": "read_file", "arguments": {"path": "math.js"}}\n</tool_call>'
    const call = detectFallbackToolCall(text, TOOLS)
    expect(call).toEqual({
      name: 'read_file',
      arguments: { path: 'math.js' },
      matchedText: text
    })
  })

  it('detects a call inside a ```json fence', () => {
    const text =
      'I\'ll start by reading the file.\n\n```json\n{"name": "read_file", "arguments": {"path": "math.js"}}\n```'
    const call = detectFallbackToolCall(text, TOOLS)
    expect(call?.name).toBe('read_file')
    expect(call?.arguments).toEqual({ path: 'math.js' })
  })

  it('detects a call inside a bare fence with no language tag', () => {
    const text = '```\n{"name": "list_directory", "arguments": {}}\n```'
    const call = detectFallbackToolCall(text, TOOLS)
    expect(call?.name).toBe('list_directory')
  })

  it('detects a bare JSON object that is the entire response', () => {
    const text = '{"name": "write_file", "arguments": {"path": "a.txt", "content": "hi"}}'
    const call = detectFallbackToolCall(text, TOOLS)
    expect(call?.name).toBe('write_file')
  })

  it('does not match a JSON example embedded mid-line in a longer explanation', () => {
    const text =
      'You would call it like this: {"name": "read_file", "arguments": {"path": "x"}} to read a file, then continue.'
    expect(detectFallbackToolCall(text, TOOLS)).toBeNull()
  })

  it('detects a call that sits alone on its own line within a longer explanation', () => {
    const text =
      "Let's start by identifying the missing function. I'll first list the directory.\n\n" +
      '{"name": "list_directory", "arguments": {"path": "."}}'
    const call = detectFallbackToolCall(text, TOOLS)
    expect(call?.name).toBe('list_directory')
  })

  it('detects a trailing embedded JSON call after prose', () => {
    const text =
      'Let me patch that now. {"name": "write_file", "arguments": {"path": "a.txt", "content": "hi"}}'
    const call = detectFallbackToolCall(text, TOOLS)
    expect(call?.name).toBe('write_file')
    expect(call?.arguments).toEqual({ path: 'a.txt', content: 'hi' })
    expect(stripFallbackCall(text, call!)).toBe('Let me patch that now.')
  })

  it('ignores a call to a tool name that is not registered', () => {
    const text = '<tool_call>{"name": "delete_everything", "arguments": {}}</tool_call>'
    expect(detectFallbackToolCall(text, TOOLS)).toBeNull()
  })

  it('ignores malformed JSON', () => {
    const text = '<tool_call>{"name": "read_file", "arguments": }</tool_call>'
    expect(detectFallbackToolCall(text, TOOLS)).toBeNull()
  })

  it('recovers a call with an invalid backslash-escaped single quote', () => {
    const text =
      '```json\n{\n  "name": "write_file",\n  "arguments": {\n    "path": "stringUtils.js",\n' +
      '    "content": "const shout = (str) => str.toUpperCase() + \'!\\\';\\n"\n  }\n}\n```'
    const call = detectFallbackToolCall(text, TOOLS)
    expect(call?.name).toBe('write_file')
    expect(call?.arguments.content).toBe("const shout = (str) => str.toUpperCase() + '!';\n")
  })

  it('returns null for ordinary text with no tool call', () => {
    expect(detectFallbackToolCall('The bug is in the add function.', TOOLS)).toBeNull()
  })

  it('defaults arguments to an empty object when omitted', () => {
    const text = '<tool_call>{"name": "list_directory"}</tool_call>'
    const call = detectFallbackToolCall(text, TOOLS)
    expect(call?.arguments).toEqual({})
  })

  it('detects a self-closing XML-style pseudo-tag with attributes as arguments', () => {
    // Regression test: observed live with gemma4-coding-Q8_0 — nudged to
    // "call preview_html", it wrote `<preview_html path="..." title="..." />`
    // literally in its reply instead of using real function-calling, and the
    // tag leaked into the chat transcript as dead text.
    const tools = new Set(['preview_html'])
    const text =
      "I'll add keyboard navigation support.\n\n" +
      '<preview_html path="index.html" title="Personal Portfolio Site" />'
    const call = detectFallbackToolCall(text, tools)
    expect(call?.name).toBe('preview_html')
    expect(call?.arguments).toEqual({ path: 'index.html', title: 'Personal Portfolio Site' })
    expect(stripFallbackCall(text, call!)).toBe("I'll add keyboard navigation support.")
  })

  it('ignores a self-closing tag with no attributes', () => {
    expect(detectFallbackToolCall('Some text with a <br/> line break.', TOOLS)).toBeNull()
  })

  it('ignores a self-closing tag whose name is not a registered tool', () => {
    const text = '<foo_bar path="x" />'
    expect(detectFallbackToolCall(text, TOOLS)).toBeNull()
  })
})

describe('findPotentialToolCallTextStart', () => {
  it('returns the beginning of trailing raw JSON so streaming can hold it', () => {
    const text = 'I will update the CSS now. {"name": "write_file"'
    expect(findPotentialToolCallTextStart(text)).toBe('I will update the CSS now. '.length)
  })

  it('returns -1 for ordinary prose', () => {
    expect(findPotentialToolCallTextStart('I will update the CSS now.')).toBe(-1)
  })
})

describe('stripFallbackCall', () => {
  it('removes the matched text and trims the remainder', () => {
    const text =
      'Let me check that file.\n\n<tool_call>{"name": "read_file", "arguments": {}}</tool_call>'
    const call = detectFallbackToolCall(text, TOOLS)!
    expect(stripFallbackCall(text, call)).toBe('Let me check that file.')
  })

  it('returns an empty string when the call was the entire response', () => {
    const text = '{"name": "read_file", "arguments": {}}'
    const call = detectFallbackToolCall(text, TOOLS)!
    expect(stripFallbackCall(text, call)).toBe('')
  })
})
