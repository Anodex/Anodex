import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveProjectPreviewHref } from '../projectPreviewNavigation'

const roots: string[] = []

function workspaceRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'anodex-project-preview-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('resolveProjectPreviewHref', () => {
  it('allows only relative workspace HTML pages', () => {
    const root = workspaceRoot()
    expect(resolveProjectPreviewHref(root, 'pages/start.html', '../next.html')).toBe('next.html')
    expect(resolveProjectPreviewHref(root, 'pages/start.html', '/nested/next.htm')).toBe(
      'nested/next.htm'
    )
  })

  it('blocks external URLs, fragments, queries, non-HTML files, and file URLs', () => {
    const root = workspaceRoot()
    for (const href of [
      'https://example.com/',
      '#details',
      'next.html?mode=test',
      'next.html#details',
      'manual.pdf',
      'file:///C:/outside.html'
    ]) {
      expect(resolveProjectPreviewHref(root, 'pages/start.html', href)).toBeNull()
    }
  })
})
