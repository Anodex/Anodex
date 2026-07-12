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
