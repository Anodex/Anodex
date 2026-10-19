import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { codeOutlineTool } from '../codeOutlineTools'
import { createMockContext, createMockDefine } from './test-helpers'

async function makeWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'anodex-outline-tool-'))
}

describe('code_outline', () => {
  it('summarizes exported symbols and imports without reading whole files', async () => {
    const workspace = await makeWorkspace()
    try {
      await mkdir(join(workspace, 'src'), { recursive: true })
      await writeFile(
        join(workspace, 'src', 'Widget.tsx'),
        [
          "import React from 'react'",
          "import { helper } from './helper'",
          'export interface WidgetProps { label: string }',
          'export function Widget(props: WidgetProps): JSX.Element { return <div /> }',
          "export const widgetName = 'Widget'",
          'class InternalOnly {}'
        ].join('\n'),
        'utf-8'
      )
      const ctx = createMockContext(workspace)
      const tool = codeOutlineTool(createMockDefine(), ctx) as unknown as {
        handler: (args: unknown) => Promise<string>
      }

      const result = await tool.handler({ path: 'src' })

      expect(result).toContain('src/Widget.tsx')
      expect(result).toContain('imports: react, ./helper')
      expect(result).toContain('interface WidgetProps')
      expect(result).toContain('function Widget')
      expect(result).toContain('const widgetName')
      expect(result).not.toContain('InternalOnly')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})

describe('code_outline in a project it cannot map', () => {
  it('reads CommonJS requires and exports, in either line ending', async () => {
    // "exports: (none)" for a file ending in module.exports = { slugify } told
    // Llama 3.1 8B the file exported nothing.
    const workspace = await makeWorkspace()
    try {
      await writeFile(
        join(workspace, 'strings.js'),
        [
          "const path = require('node:path')",
          'function slugify(text) { return text }',
          'function capitalize(text) { return text }',
          'exports.VERSION = 2',
          'module.exports = { slugify, capitalize: capitalize }'
        ].join('\r\n'),
        'utf-8'
      )
      await writeFile(join(workspace, 'single.js'), 'function main() {}\nmodule.exports = main\n')
      const ctx = createMockContext(workspace)
      const tool = codeOutlineTool(createMockDefine(), ctx) as unknown as {
        handler: (args: unknown) => Promise<string>
      }

      const result = await tool.handler({ path: '.' })

      expect(result).toContain('imports: node:path')
      expect(result).toContain('export slugify')
      expect(result).toContain('export capitalize')
      expect(result).toContain('export VERSION')
      expect(result).toContain('export default main')
      expect(result).not.toContain('exports: (none)')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('does not claim a directory full of Python has no source files', async () => {
    const workspace = await makeWorkspace()
    try {
      await writeFile(join(workspace, 'physics.py'), 'def total_mass(bodies):\n    pass\n', 'utf-8')
      await writeFile(join(workspace, 'ui.py'), 'class Camera:\n    pass\n', 'utf-8')
      const ctx = createMockContext(workspace)
      const tool = codeOutlineTool(createMockDefine(), ctx) as unknown as {
        handler: (args: unknown) => Promise<string>
      }

      const result = await tool.handler({ path: '.' })

      // The old message was "No source files found." — false, and it reads as
      // "this directory has no code", which is the opposite of the truth.
      expect(result).not.toContain('No source files found')
      // It must say what it cannot do, and what is actually there.
      expect(result).toContain('.py')
      expect(result.toLowerCase()).toContain('javascript')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('still reports a genuinely empty directory as empty', async () => {
    const workspace = await makeWorkspace()
    try {
      await mkdir(join(workspace, 'empty'), { recursive: true })
      const ctx = createMockContext(workspace)
      const tool = codeOutlineTool(createMockDefine(), ctx) as unknown as {
        handler: (args: unknown) => Promise<string>
      }

      const result = await tool.handler({ path: 'empty' })

      expect(result).toContain('No source files found')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
