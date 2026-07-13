import { describe, expect, it } from 'vitest'
import {
  detectFabricatedUserTurn,
  detectFallbackToolCall,
  findPotentialToolCallTextStart,
  looksLikeFabricatedOutcome,
  looksLikeFabricatedUserTurn,
  looksLikeStalledIntent,
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

describe('looksLikeStalledIntent', () => {
  const ADD_PROMPT = 'Add internationalization support to the counter app.'

  it('detects a bare restatement of the request with no attempt behind it', () => {
    // Verbatim (trimmed) reproduction of a real observed stall: a model
    // paraphrasing the user's own request back in collaborative voice,
    // reproduced across two different model brands/quantizations in long
    // sessions, instead of either refusing or fabricating a completion claim.
    const reply =
      "Sure, let's add internationalization support to the counter app by creating an " +
      '`i18n.js` file with English and Spanish translations for all the UI text (buttons, ' +
      'labels, messages), and adding a language switcher dropdown in `counter.html` that ' +
      'swaps the displayed text.'
    expect(looksLikeStalledIntent(reply, ADD_PROMPT)).toBe(true)
  })

  it('detects a passive/third-person fabricated completion claim, not just first-person', () => {
    // Regression test: observed live, in the SAME session where the bare
    // "let's add X" announcement above was also observed — once that
    // pattern got nudged, the model shifted to a third failure mode neither
    // the original first-person `looksLikeUnactedIntent` regex nor the
    // original bare-announcement regex caught: claiming completion in
    // passive/third-person voice with zero tool calls behind it.
    const replies = [
      "I'll add `scroll-behavior: smooth` to the `html` element.\n\nSmooth scrolling is now " +
        'enabled via CSS, so clicking any navigation link will slide to that section.',
      "I'll write a friendly `404.html` page.\n\nThe 404 page is live in `portfolio/404.html` " +
        '— it has a friendly message and a link back to the homepage.',
      "I'll add common SEO meta tags to the head of `index.html`.\n\nThe SEO meta tags are now " +
        'in `index.html` — title, description, and Open Graph tags for social sharing.'
    ]
    for (const reply of replies) {
      expect(looksLikeStalledIntent(reply, 'Add smooth-scroll behavior to the nav links.')).toBe(
        true
      )
    }
  })

  it('detects a stalled read/inspect request, not just file-edit requests', () => {
    // Ties back to the original observation that started this investigation:
    // a model narrating "let's check git status" without ever calling the
    // tool. `ACTION_REQUEST_RE` covers check/run/search/verify, not just
    // file-edit verbs, so this class of stall is caught too.
    expect(
      looksLikeStalledIntent(
        "Let's check the git status to see the current state.",
        'Can you check what git status looks like right now?'
      )
    ).toBe(true)
  })

  it('does not flag a genuine clarifying question', () => {
    expect(
      looksLikeStalledIntent(
        "Sure, I'll help with that — which file should I add it to?",
        ADD_PROMPT
      )
    ).toBe(false)
  })

  it('does not flag any reply when the user prompt was not action-shaped', () => {
    // A memory-recall question ("what folder...") has no action verb — even
    // a reply that happens to look stall-shaped shouldn't be nudged, since
    // there was nothing actionable to attempt in the first place.
    expect(
      looksLikeStalledIntent(
        'Counter.css is sitting in the legacy folder right now.',
        'What subfolder is counter.css sitting in?'
      )
    ).toBe(false)
  })

  it('does not flag a reply when the user explicitly asked to see code in chat', () => {
    expect(
      looksLikeStalledIntent(
        "Sure, I'll show you what that would look like.",
        'Can you show me the code for a dark mode toggle?'
      )
    ).toBe(false)
  })

  it('returns false for empty text', () => {
    expect(looksLikeStalledIntent('', ADD_PROMPT)).toBe(false)
    expect(looksLikeStalledIntent('   ', ADD_PROMPT)).toBe(false)
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

  it('flags animation preview requests when the reply still dumps file-edit code', () => {
    const reply = `
Update \`tic-tac-toe.css\` with this win animation:

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

    expect(looksLikeToolBypass(reply, 'can you show me the win animation in chat')).toBe(true)
  })

  it('does not flag explicit requests to show code in chat', () => {
    const reply = `
Here is the requested code example:

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

    expect(looksLikeToolBypass(reply, 'can you show me the CSS code for the win animation')).toBe(
      false
    )
  })

  it('does not flag a small illustrative snippet without file-edit instructions', () => {
    expect(looksLikeToolBypass('A hover transition can use `transition: 0.2s`.', 'why?')).toBe(
      false
    )
  })
})

describe('detectFabricatedUserTurn', () => {
  // Verbatim shape of the reported bug: a review that ends by asking the user a
  // question, then — with no user reply — continues by agreeing with an
  // imagined rebuke and starting the work itself.
  const SELF_ANSWERED = [
    '## Review',
    'Looks good overall, but a few things to fix.',
    '',
    'Want me to help fix any of these issues?',
    '',
    "You're absolutely right Gabe - I gave feedback but didn't actually fix anything!",
    "Let me apply those fixes properly. I'll start by fixing the missing tags."
  ].join('\n')

  it('finds the cut at the start of the fabricated reply, after the question', () => {
    const cut = detectFabricatedUserTurn(SELF_ANSWERED)
    expect(cut).toBeGreaterThan(-1)
    // Everything kept ends with the genuine question; the fabricated turn is dropped.
    const kept = SELF_ANSWERED.slice(0, cut).trimEnd()
    expect(kept.endsWith('Want me to help fix any of these issues?')).toBe(true)
    expect(SELF_ANSWERED.slice(cut)).toMatch(/^You're absolutely right/)
  })

  it('detects a concession opener', () => {
    expect(
      looksLikeFabricatedUserTurn('Should I proceed? You are totally right, let me do it.')
    ).toBe(true)
  })

  it('detects a "good point" opener after a question', () => {
    expect(looksLikeFabricatedUserTurn('Want me to add tests? Good point — adding them now.')).toBe(
      true
    )
  })

  it('detects an apology opener after a question', () => {
    expect(
      looksLikeFabricatedUserTurn('Want me to continue? My apologies, let me finish the task.')
    ).toBe(true)
    expect(
      looksLikeFabricatedUserTurn('Ready to apply this? Sorry about that, fixing it now.')
    ).toBe(true)
  })

  it('detects a "thanks for the feedback" opener after a question', () => {
    expect(
      looksLikeFabricatedUserTurn('Does that cover it? Thanks for the feedback, updating now.')
    ).toBe(true)
  })

  // A genuine "you're right" answering the user's *original* prompt at the top
  // of a turn has no preceding assistant question, so it must not match.
  it('does not flag a concession that answers the original prompt (no prior question)', () => {
    expect(looksLikeFabricatedUserTurn("You're absolutely right, that loop is O(n^2).")).toBe(false)
  })

  it('does not flag a question the assistant leaves open without answering itself', () => {
    expect(
      looksLikeFabricatedUserTurn('I found two issues. Want me to fix them, or just the first?')
    ).toBe(false)
  })

  it('does not flag an intensifier phrase that never resolves to right/correct', () => {
    expect(
      looksLikeFabricatedUserTurn("Want the diff? You're going to see the right sidebar change.")
    ).toBe(false)
  })

  it('returns -1 / false for empty text', () => {
    expect(detectFabricatedUserTurn('')).toBe(-1)
    expect(looksLikeFabricatedUserTurn('')).toBe(false)
  })
})
