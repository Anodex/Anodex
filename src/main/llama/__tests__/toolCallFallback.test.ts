import { describe, expect, it } from 'vitest'
import {
  detectFallbackToolCall,
  findPotentialToolCallTextStart,
  looksLikeFabricatedOutcome,
  looksLikeToolBypass,
  looksLikeUnactedIntent,
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

describe('looksLikeUnactedIntent', () => {
  it('detects a completion claim in a short summary', () => {
    expect(looksLikeUnactedIntent("I've added the missing titleCase function.")).toBe(true)
  })

  it('detects a completion claim at the end of a long, otherwise-unrelated reply', () => {
    const text =
      'Here is a long explanation of the bug. '.repeat(20) +
      '\n\nSummary:\n- I fixed the add function to use + instead of -.'
    expect(looksLikeUnactedIntent(text)).toBe(true)
  })

  it('ignores plain narration with no completion claim', () => {
    expect(looksLikeUnactedIntent("I'll start by reading the file to see what's wrong.")).toBe(
      false
    )
  })

  it('returns false for empty text', () => {
    expect(looksLikeUnactedIntent('')).toBe(false)
    expect(looksLikeUnactedIntent('   ')).toBe(false)
  })

  it('only checks near the end, not a claim buried far before the tail', () => {
    const text = "I've added the function.\n\n" + 'x'.repeat(700)
    expect(looksLikeUnactedIntent(text)).toBe(false)
  })
})

describe('looksLikeFabricatedOutcome', () => {
  it('detects a fabricated denial that references the user', () => {
    expect(
      looksLikeFabricatedOutcome(
        'The user denied adding the shout(str) function to stringUtils.js.'
      )
    ).toBe(true)
  })

  it('detects a fabricated approval', () => {
    expect(looksLikeFabricatedOutcome('The user approved the change to app.js.')).toBe(true)
  })

  it('detects a fabricated test/build result', () => {
    expect(looksLikeFabricatedOutcome('I ran it and the tests passed.')).toBe(true)
    expect(looksLikeFabricatedOutcome('The build succeeded with no errors.')).toBe(true)
  })

  it('ignores plain narration with no outcome claim', () => {
    expect(looksLikeFabricatedOutcome("I'll ask before making this change.")).toBe(false)
  })

  it('returns false for empty text', () => {
    expect(looksLikeFabricatedOutcome('')).toBe(false)
    expect(looksLikeFabricatedOutcome('   ')).toBe(false)
  })

  it('only checks near the end, not a claim buried far before the tail', () => {
    const text = 'The user denied the change.\n\n' + 'x'.repeat(700)
    expect(looksLikeFabricatedOutcome(text)).toBe(false)
  })
})

describe('looksLikeToolBypass', () => {
  it('detects a tic-tac-toe reply that dumps CSS instead of editing the file', () => {
    const reply = `
Sure, let's improve the game styling.

### Step 1: Update \`tic-tac-toe.css\`
Add the following CSS to make the board more polished.

\`\`\`css
body {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
}

.cell {
  transition: transform 0.2s ease, background-color 0.2s ease;
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.25);
}
\`\`\`
`

    expect(looksLikeToolBypass(reply, 'keep improving it')).toBe(true)
  })

  it('detects a JavaScript patch suggestion when the user asked for a change', () => {
    const reply = `
Update \`tic-tac-toe.js\` with this logic for the win overlay:

\`\`\`js
function showWinScreen(winner) {
  const overlay = document.querySelector('#result-overlay');
  overlay.classList.add('visible');
  overlay.querySelector('.title').textContent = winner === playerSymbol ? 'You won!' : 'You lost';
}
\`\`\`
`

    expect(looksLikeToolBypass(reply, 'make a you lose screen and confetti you won screen')).toBe(
      true
    )
  })

  it('does not flag explicit requests to show code in chat', () => {
    const reply = `
Here is the win animation code:

\`\`\`css
@keyframes winPulse {
  0% { transform: scale(1); }
  50% { transform: scale(1.18); }
  100% { transform: scale(1); }
}

.winning-cell {
  animation: winPulse 0.7s ease-in-out infinite;
}
\`\`\`
`

    expect(looksLikeToolBypass(reply, 'can you show me the win animation in chat')).toBe(false)
  })

  it('does not flag a small illustrative snippet without file-edit instructions', () => {
    expect(looksLikeToolBypass('A hover transition can use `transition: 0.2s`.', 'why?')).toBe(
      false
    )
  })
})
