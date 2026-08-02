import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prepareHtmlPreviewSource } from '../previewTools'

let workspaceRoot: string

function write(relativePath: string, content: string): void {
  const file = join(workspaceRoot, relativePath)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, content, 'utf-8')
}

describe('prepareHtmlPreviewSource', () => {
  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'anodex-preview-tools-'))
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  /**
   * The bug this covers: an `srcDoc` iframe has no base URL, so a page's own
   * `<link rel="stylesheet" href="style.css">` resolved to nothing and the
   * file viewer rendered every AI-built page as unstyled markup.
   */
  it('inlines a sibling stylesheet the page links to', async () => {
    write('style.css', 'body { background: #000; }')

    const result = await prepareHtmlPreviewSource(
      workspaceRoot,
      'index.html',
      '<html><head><link rel="stylesheet" href="style.css"></head><body></body></html>'
    )

    expect(result).toContain('<style')
    expect(result).toContain('body { background: #000; }')
    expect(result).not.toContain('<link')
  })

  it('inlines a sibling script the page references', async () => {
    write('app.js', 'console.log("hi")')

    const result = await prepareHtmlPreviewSource(
      workspaceRoot,
      'index.html',
      '<html><body><script src="app.js"></script></body></html>'
    )

    expect(result).toContain('console.log("hi")')
  })

  it('resolves assets relative to the HTML file, not the workspace root', async () => {
    write('pages/nested/style.css', '.nested { color: red; }')

    const result = await prepareHtmlPreviewSource(
      workspaceRoot,
      'pages/nested/index.html',
      '<link rel="stylesheet" href="style.css">'
    )

    expect(result).toContain('.nested { color: red; }')
  })

  it('leaves external stylesheets and scripts alone', async () => {
    const result = await prepareHtmlPreviewSource(
      workspaceRoot,
      'index.html',
      '<link rel="stylesheet" href="https://cdn.example.com/x.css">'
    )

    expect(result).toContain('https://cdn.example.com/x.css')
  })

  /**
   * The preview runs against the live editor buffer, so it routinely sees a
   * page whose sibling file hasn't been written yet — that must render the
   * markup unstyled, not fail the whole preview with an ENOENT.
   */
  it('still renders when a referenced asset does not exist', async () => {
    const result = await prepareHtmlPreviewSource(
      workspaceRoot,
      'index.html',
      '<link rel="stylesheet" href="missing.css"><h1>Hello</h1>'
    )

    expect(result).toContain('<h1>Hello</h1>')
    expect(result).toContain('missing.css')
  })

  it('inlines a local image as a data URL', async () => {
    const file = join(workspaceRoot, 'logo.png')
    writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const result = await prepareHtmlPreviewSource(
      workspaceRoot,
      'index.html',
      '<img src="logo.png">'
    )

    expect(result).toContain('data:image/png;base64,')
  })

  it('refuses to inline an asset from outside the workspace', async () => {
    const result = await prepareHtmlPreviewSource(
      workspaceRoot,
      'index.html',
      '<link rel="stylesheet" href="../../../etc/passwd">'
    )

    expect(result).toContain('<link')
    expect(result).not.toContain('root:')
  })

  it('rejects a preview that is too large once assets are inlined', async () => {
    write('big.css', 'a'.repeat(2000))

    await expect(
      prepareHtmlPreviewSource(
        workspaceRoot,
        'index.html',
        '<link rel="stylesheet" href="big.css">',
        {
          maxContentChars: 500
        }
      )
    ).rejects.toThrow(/too large/i)
  })
})
