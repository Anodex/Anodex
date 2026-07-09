import { describe, expect, it } from 'vitest'
import {
  detectToolCallText,
  stripLeakedChannelTokens,
  stripSubstantialCodeFences,
  stripToolCallText
} from '../toolCallText'

describe('detectToolCallText', () => {
  it('detects a self-closing XML-style pseudo-tag with attributes as arguments', () => {
    const tools = new Set(['preview_html'])
    const text = '<preview_html path="index.html" title="Personal Portfolio Site" />'
    const match = detectToolCallText(text, tools)
    expect(match?.name).toBe('preview_html')
    expect(match?.arguments).toEqual({ path: 'index.html', title: 'Personal Portfolio Site' })
  })

  it('ignores a self-closing tag whose name is not a registered tool', () => {
    expect(detectToolCallText('<foo_bar path="x" />', new Set(['preview_html']))).toBeNull()
  })
})

describe('stripToolCallText', () => {
  it('removes a leaked self-closing tool tag from displayed text', () => {
    const tools = new Set(['preview_html'])
    const text =
      "I'll add keyboard navigation support.\n\n" +
      '<preview_html path="index.html" title="Personal Portfolio Site" />'
    expect(stripToolCallText(text, tools)).toBe("I'll add keyboard navigation support.")
  })
})

describe('stripSubstantialCodeFences', () => {
  it('removes a substantial code fence pasted back after a real write succeeded', () => {
    const reply =
      "Thank you for providing the current content. I'll manually apply the changes.\n\n" +
      "### Updated `tic-tac-toe.css`\nHere's the updated content for `tic-tac-toe.css`:\n\n" +
      '```css\n' +
      'body {\n  display: flex;\n  flex-direction: column;\n  justify-content: center;\n' +
      '  align-items: center;\n  height: 100vh;\n  margin: 0;\n  background-color: #1e1e24;\n' +
      '}\n\n@keyframes winAnimation {\n  0% { transform: scale(1); }\n  100% { transform: scale(1); }\n}\n' +
      '```\n\nLet me know if you would like any further changes.'

    const stripped = stripSubstantialCodeFences(reply, 'add a win animation')
    expect(stripped).not.toContain('```')
    expect(stripped).not.toContain('background-color: #1e1e24')
    expect(stripped).toContain("I'll manually apply the changes.")
    expect(stripped).toContain('Let me know if you would like any further changes.')
  })

  it('removes a code fence even when nothing has been written yet (pure bypass)', () => {
    const reply =
      "Sure, here's the updated CSS:\n\n```css\nbody {\n  display: flex;\n  align-items: center;\n" +
      '  justify-content: center;\n  min-height: 100vh;\n}\n\n.cell {\n  transition: transform 0.2s;\n' +
      '}\n```\n\nApply that to your file.'
    const stripped = stripSubstantialCodeFences(reply, 'improve the styling')
    expect(stripped).not.toContain('```')
    expect(stripped).not.toContain('min-height: 100vh')
  })

  it('removes a fence that reproduces a file the model just read (not just wrote)', () => {
    // Regression: live testing found a model narrating "the first five lines
    // of counter.html are:" followed by a pasted ```html fence after calling
    // read_file_range — not a write/bypass scenario at all, just a redundant
    // recap of read content. Any substantial fence should go.
    const reply =
      'The first five lines of `counter.html` are:\n\n```html\n<!DOCTYPE html>\n' +
      '<html lang="en">\n<head>\n    <meta charset="UTF-8">\n' +
      '    <meta name="viewport" content="width=device-width, initial-scale=1.0">\n```\n\n' +
      "Now, let's read `counter.html` and `counter.js` together."
    const stripped = stripSubstantialCodeFences(reply, 'read lines 1 through 5 of counter.html')
    expect(stripped).not.toContain('```')
    expect(stripped).not.toContain('<!DOCTYPE html>')
    expect(stripped).toContain('The first five lines of `counter.html` are:')
    expect(stripped).toContain("Now, let's read `counter.html` and `counter.js` together.")
  })

  it('removes a fence tagged with a non-web-dev language, not just the css/html/js allowlist', () => {
    // Regression: observed live — a README.md request produced a
    // ```markdown fence, and an RSS feed request produced a ```xml fence,
    // and neither was stripped, because the old logic only treated an
    // explicit tag as "code" when it was in a hardcoded css/html/js/json/
    // ts/tsx allowlist. Any explicit language tag should count — the model
    // naming a language at all is the signal, not which language it named.
    const readme =
      "I'll create a `README.md` that explains the project.\n\n```markdown\n" +
      '## Personal Portfolio Site\n\nA simple, responsive portfolio site built with vanilla ' +
      'HTML, CSS, and JavaScript. This project serves as a showcase for frontend skills.\n```'
    const strippedReadme = stripSubstantialCodeFences(readme, 'write a README for this project')
    expect(strippedReadme).not.toContain('```')
    expect(strippedReadme).not.toContain('## Personal Portfolio Site')

    const feed =
      "I'll create `feed.xml` listing the posts.\n\n```xml\n<?xml version=\"1.0\"?>\n<rss>\n" +
      '<channel><title>Blog</title><item><title>Post 1</title></item></channel>\n</rss>\n```'
    const strippedFeed = stripSubstantialCodeFences(feed, 'add an RSS feed.xml file')
    expect(strippedFeed).not.toContain('```')
    expect(strippedFeed).not.toContain('<rss>')
  })

  it('leaves the code alone when the user explicitly asked to see it', () => {
    const reply =
      "Here's the requested code example:\n\n```css\nbody {\n  display: flex;\n  align-items: center;\n" +
      '  justify-content: center;\n  min-height: 100vh;\n}\n\n.cell {\n  transition: transform 0.2s;\n' +
      '}\n```'
    expect(stripSubstantialCodeFences(reply, 'can you show me the CSS code for the layout')).toBe(
      reply
    )
  })

  it('leaves a small illustrative snippet untouched', () => {
    const reply = 'A hover transition can use `transition: 0.2s`.'
    expect(stripSubstantialCodeFences(reply, 'why?')).toBe(reply)
  })

  it('leaves plain prose with no fence untouched', () => {
    const reply = 'Done — the win animation now plays when a player wins.'
    expect(stripSubstantialCodeFences(reply, 'add a win animation')).toBe(reply)
  })
})

describe('stripLeakedChannelTokens', () => {
  it('removes all three observed leaked marker variants', () => {
    // Regression: observed live with a Gemma fine-tune — node-llama-cpp's
    // Gemma4ChatWrapper expects a paired `<|channel>thought` / `<channel|>`
    // token sequence to mark a hidden-reasoning boundary, consumed
    // internally. A model that doesn't reproduce that sequence exactly
    // leaves the wrapper unable to recognize the marker, so it falls
    // through into the visible reply as literal text.
    expect(stripLeakedChannelTokens("I'll add the footer.<channel|>Done.")).toBe(
      "I'll add the footer.Done."
    )
    expect(stripLeakedChannelTokens('<channel>Some text</channel> after.')).toBe(
      'Some text after.'
    )
  })

  it('leaves ordinary text with no leaked marker untouched', () => {
    const reply = 'Done — the footer now has social icons and a copyright line.'
    expect(stripLeakedChannelTokens(reply)).toBe(reply)
  })

  it('does not touch real HTML the model legitimately writes', () => {
    // Narrow by design: only the exact "channel" artifact shape is
    // stripped, not angle-bracketed content in general.
    const reply = 'Add `<div class="channel">` for the video channel section.'
    expect(stripLeakedChannelTokens(reply)).toBe(reply)
  })
})
