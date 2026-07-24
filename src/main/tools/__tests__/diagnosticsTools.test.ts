import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import type { ToolConfirmRequest } from '@shared/tools.types'
import { runProjectCheckTool } from '../diagnosticsTools'
import { createMockContext, createMockDefine } from './test-helpers'

async function makeWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'anodex-check-tool-'))
}

describe('run_project_check', () => {
  it('classifies a destructive custom command as destructive in untethered mode', async () => {
    const workspace = await makeWorkspace()
    try {
      const requests: ToolConfirmRequest[] = []
      const ctx = {
        ...createMockContext(workspace),
        projectId: 'project-1',
        permissionMode: 'untethered' as const,
        confirm: (request: ToolConfirmRequest) => {
          requests.push(request)
          return Promise.resolve({ approved: false })
        }
      }
      const tool = runProjectCheckTool(createMockDefine(), ctx) as unknown as {
        handler: (args: unknown) => Promise<string>
      }

      await tool.handler({ kind: 'custom', command: 'rm -rf build' })

      expect(requests[0]?.risk).toBe('destructive')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('runs a known npm script and returns a structured pass result', async () => {
    const workspace = await makeWorkspace()
    try {
      await writeFile(
        join(workspace, 'package.json'),
        JSON.stringify({ scripts: { typecheck: 'node -e "console.log(\'types ok\')"' } }),
        'utf-8'
      )
      const ctx = {
        ...createMockContext(workspace),
        projectId: 'project-1',
        permissionMode: 'untethered' as const
      }
      const tool = runProjectCheckTool(createMockDefine(), ctx) as unknown as {
        handler: (args: unknown) => Promise<string>
      }

      const result = await tool.handler({ kind: 'typecheck' })

      expect(result).toContain('"status": "passed"')
      expect(result).toContain('"kind": "typecheck"')
      expect(result).toContain('types ok')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('reports non-zero checks as failed with parsed failure hints', async () => {
    const workspace = await makeWorkspace()
    try {
      await writeFile(
        join(workspace, 'package.json'),
        JSON.stringify({
          scripts: {
            lint: 'node -e "console.error(\'src/app.ts:4:2 error bad lint\'); process.exit(2)"'
          }
        }),
        'utf-8'
      )
      const ctx = {
        ...createMockContext(workspace),
        projectId: 'project-1',
        permissionMode: 'untethered' as const
      }
      const tool = runProjectCheckTool(createMockDefine(), ctx) as unknown as {
        handler: (args: unknown) => Promise<string>
      }

      const result = await tool.handler({ kind: 'lint' })

      expect(result).toContain('"status": "failed"')
      expect(result).toContain('src/app.ts:4:2 error bad lint')
      expect(result).toContain('"exitCode": 2')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
