import { describe, expect, it } from 'vitest'
import { decodeEntities, htmlToReadableText } from '../htmlToText'
import { looksLikeBoilerplatePassage } from '../webTools'

describe('htmlToReadableText', () => {
  it('separates blocks with blank lines, which is how passages get split', () => {
    // extractFocusedPassages splits on /\n{2,}/ — collapsing a page into one
    // run would hand the ranker a single unusable chunk.
    const text = htmlToReadableText('<p>First idea.</p><p>Second idea.</p>')

    expect(text).toBe('First idea.\n\nSecond idea.')
  })

  it('keeps link text and drops the href', () => {
    expect(htmlToReadableText('<p>See <a href="https://example.com">the docs</a> now.</p>')).toBe(
      'See the docs now.'
    )
  })

  it('never leaks script or style source into the text', () => {
    const text = htmlToReadableText(
      '<style>.a{color:red}</style><script>var x = "hello"</script><p>Real content</p>'
    )

    expect(text).toBe('Real content')
  })

  it('drops page chrome that used to reach the evidence packet', () => {
    // The bee-shop menu case the boilerplate filter was written for.
    const text = htmlToReadableText(
      '<nav><ul><li>Body care</li><li>Soaps</li></ul></nav>' +
        '<p>Bees produce propolis.</p>' +
        '<footer><p>Copyright 2026</p></footer>'
    )

    expect(text).toBe('Bees produce propolis.')
  })

  it('narrows to the marked article when a page declares one', () => {
    const body = `<p>${'The real content of the page. '.repeat(10)}</p>`
    const text = htmlToReadableText(
      `<div><p>Sidebar junk</p></div><article>${body}</article><div><p>More junk</p></div>`
    )

    expect(text).toContain('The real content')
    expect(text).not.toContain('junk')
  })

  it('keeps the whole page when it marks nothing, rather than guessing', () => {
    const text = htmlToReadableText('<div><p>Alpha</p></div><div><p>Beta</p></div>')

    expect(text).toContain('Alpha')
    expect(text).toContain('Beta')
  })

  it('ignores a token <main> that wraps almost nothing', () => {
    const text = htmlToReadableText(
      `<main><h1>Title</h1></main><p>${'Body text that carries the article. '.repeat(10)}</p>`
    )

    expect(text).toContain('Body text that carries the article')
  })

  it('keeps a list in one passage so the boilerplate detector can count markers', () => {
    // The detector counts markers *within* a passage. If each item became its
    // own passage it would never reach the threshold and menus would sail
    // through into the evidence packet.
    // Seven items, because the detector matches whitespace on *both* sides of
    // a marker and a passage is trimmed before it is tested — so the first
    // item's marker never counts and the effective threshold is one higher
    // than the constant suggests. Pre-existing behaviour, unchanged by this
    // converter; noted here so the number is not mistaken for a typo.
    const items = [
      'Body care',
      'Massage oils',
      'Soaps',
      'Foot care',
      'Candles',
      'Gifts',
      'Wholesale'
    ]
    const text = htmlToReadableText(
      `<div><ul>${items.map((item) => `<li>${item}</li>`).join('')}</ul></div>`
    )

    expect(text.split(/\n{2,}/)).toHaveLength(1)
    expect(looksLikeBoilerplatePassage(text)).toBe(true)
  })

  it('does not flag a genuine bulleted list of full sentences', () => {
    const text = htmlToReadableText(
      `<ul>${[
        'Rinse the wound with clean water.',
        'Apply gentle pressure to stop bleeding.',
        'Cover it with a sterile dressing.'
      ]
        .map((item) => `<li>${item}</li>`)
        .join('')}</ul>`
    )

    expect(looksLikeBoilerplatePassage(text)).toBe(false)
  })

  it('separates table cells instead of running them into one word sequence', () => {
    const text = htmlToReadableText(
      '<table><tr><td>Widget</td><td>42</td></tr><tr><td>Gadget</td><td>7</td></tr></table>'
    )

    expect(text).toContain('Widget • 42')
    expect(text).toContain('Gadget • 7')
  })

  it('preserves indentation and line breaks inside a code sample', () => {
    const text = htmlToReadableText(
      '<p>Example:</p><pre><code>function f() {\n  return 1\n}</code></pre>'
    )

    expect(text).toContain('function f() {\n  return 1\n}')
  })

  it('turns <br> into a line break without starting a new passage', () => {
    expect(htmlToReadableText('<p>Line one<br>Line two</p>')).toBe('Line one\nLine two')
  })

  it('skips images rather than emitting alt text as prose', () => {
    const text = htmlToReadableText('<p>Before <img src="x.png" alt="A chart"> after</p>')

    expect(text).not.toContain('A chart')
    expect(text).toContain('Before')
    expect(text).toContain('after')
  })

  it('survives an unclosed chrome tag instead of swallowing the article', () => {
    // Losing the page because someone forgot </nav> is worse than one stray menu.
    const text = htmlToReadableText('<nav><p>Menu</p><p>The actual article body.</p>')

    expect(text).toContain('The actual article body.')
  })

  it('collapses runaway blank lines from deeply nested wrappers', () => {
    const text = htmlToReadableText('<div><div><div><p>Only text</p></div></div></div>')

    expect(text).toBe('Only text')
  })

  it('returns empty for a page with no text at all', () => {
    expect(htmlToReadableText('<html><head><title>x</title></head><body></body></html>')).toBe('')
  })
})

describe('decodeEntities', () => {
  it('decodes the named entities that show up in prose', () => {
    expect(decodeEntities('caf&eacute;')).toBe('caf&eacute;') // not in the prose set
    expect(decodeEntities('A &amp; B &mdash; C&hellip;')).toBe('A & B — C…')
  })

  it('decodes decimal and hexadecimal forms', () => {
    expect(decodeEntities('&#65;&#x42;&#128512;')).toBe('AB😀')
  })

  it('does not double-decode an escaped entity the page wrote literally', () => {
    // The page meant to show the text "&lt;", not the character "<".
    expect(decodeEntities('&amp;lt;')).toBe('&lt;')
  })

  it('leaves malformed or out-of-range references alone', () => {
    expect(decodeEntities('&notarealentity;')).toBe('&notarealentity;')
    expect(decodeEntities('&#1114112;')).toBe('&#1114112;')
    expect(decodeEntities('&#xD800;')).toBe('&#xD800;')
  })
})

describe('attribute values', () => {
  it('keeps a > inside a single-quoted attribute out of the text', () => {
    // Wikipedia carries an article's whole template source in a single-quoted
    // data-mw attribute, and that JSON contains `>`. Tag matching ended at
    // that `>`, so the rest of the JSON became body text and research runs
    // quoted `{{cite web ...}}` back as if it were prose.
    const html =
      `<div data-mw='{"parts":[{"template":{"wt":"&lt;/ref>"},` +
      `"genre":{"wt":"[[Simulation]]"}}]}'>Real prose here.</div>`
    const text = htmlToReadableText(html)

    expect(text).toContain('Real prose here.')
    expect(text).not.toContain('{"wt"')
    expect(text).not.toContain('genre')
    expect(text).not.toContain('[[Simulation]]')
  })

  it('keeps a > inside a double-quoted attribute out of the text', () => {
    const text = htmlToReadableText('<p title="a > b">Visible.</p>')

    expect(text).toContain('Visible.')
    expect(text).not.toContain('a > b')
  })

  it('still recognises tags whose attributes were dropped', () => {
    // The layout passes key off tag names, so stripping values must not stop
    // a list or a line break from producing its whitespace.
    const text = htmlToReadableText(
      `<ul class='x'><li id='a'>One</li><li id='b'>Two</li></ul><p>After<br class='y'/>Split</p>`
    )

    expect(text).toContain('* One')
    expect(text).toContain('* Two')
    expect(text).toContain('After\nSplit')
  })

  it('leaves ordinary text containing a greater-than sign alone', () => {
    expect(htmlToReadableText('<p>3 &gt; 2 is true</p>')).toContain('3 > 2 is true')
  })
})
