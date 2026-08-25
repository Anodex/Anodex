import { describe, it, expect } from 'vitest'
import { detectFallbackToolCall, stripFallbackCall } from '../toolCallFallback'
import {
  DEEPSEEK_CALL_BEGIN,
  DEEPSEEK_CALL_END,
  DEEPSEEK_CALLS_END,
  DEEPSEEK_OUTPUTS_BEGIN,
  DEEPSEEK_OUTPUTS_END,
  DEEPSEEK_OUTPUT_BEGIN,
  DEEPSEEK_OUTPUT_END,
  DEEPSEEK_SEP
} from '@shared/deepSeekMarkers'

const TOOLS = new Set(['read_file_range', 'edit_file', 'list_directory'])

function call(name: string, params: string): string {
  return `${DEEPSEEK_CALL_BEGIN}function${DEEPSEEK_SEP}${name}\n\`\`\`json\n${params}\n\`\`\`${DEEPSEEK_CALL_END}`
}

function output(body: string): string {
  return `${DEEPSEEK_OUTPUTS_BEGIN}${DEEPSEEK_OUTPUT_BEGIN}${body}${DEEPSEEK_OUTPUT_END}${DEEPSEEK_OUTPUTS_END}`
}

describe('DeepSeek calls leaked as text', () => {
  it('recovers a call whose name sits outside the JSON fence', () => {
    const text = `I'll read the file first.\n\n${call('read_file_range', '{"path": "js/universe-sandbox.js", "startLine": 1, "endLine": 5}')}${DEEPSEEK_CALLS_END}`

    expect(detectFallbackToolCall(text, TOOLS)).toMatchObject({
      name: 'read_file_range',
      arguments: { path: 'js/universe-sandbox.js', startLine: 1, endLine: 5 }
    })
  })

  it('keeps the commentary written before the call and drops the invented result', () => {
    const text = [
      "I'll read the file first.",
      '',
      call('read_file_range', '{"path": "a.js", "startLine": 1, "endLine": 5}') +
        DEEPSEEK_CALLS_END,
      output('{"lines": ["invented contents"]}'),
      'The file imports THREE as an ES module, so I will rewrite it.',
      call('edit_file', '{"path": "a.js", "oldText": "x", "newText": "y"}') + DEEPSEEK_CALLS_END,
      output('{"status": "success"}'),
      'Done — the imports are now global.'
    ].join('\n')

    const detected = detectFallbackToolCall(text, TOOLS)
    expect(detected?.name).toBe('read_file_range')

    const visible = stripFallbackCall(text, detected!)
    expect(visible).toBe("I'll read the file first.")
    expect(visible).not.toContain('invented contents')
    expect(visible).not.toContain('success')
    expect(visible).not.toContain(DEEPSEEK_CALL_BEGIN)
  })

  it('ignores a leaked call naming a tool that is not registered', () => {
    const text = call('definitely_not_a_tool', '{"path": "a.js"}')
    expect(detectFallbackToolCall(text, TOOLS)).toBeNull()
  })

  it('recovers a call with no arguments', () => {
    const text = `Checking.\n${call('list_directory', '{}')}`
    expect(detectFallbackToolCall(text, TOOLS)).toMatchObject({
      name: 'list_directory',
      arguments: {}
    })
  })
})
