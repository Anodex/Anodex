import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Skill } from '@shared/skill.types'
import { findSkillTool, loadSkillTool } from '../skillTools'
import type { ToolRuntimeContext } from '../types'
import { createMockContext, createMockDefine } from './test-helpers'

const mocks = vi.hoisted(() => ({
  list: vi.fn<(workspaceRoot?: string | null) => Skill[]>(),
  get: vi.fn<(name: string, workspaceRoot?: string | null) => Skill | null>(),
  getDir: vi.fn(() => '/personal/skills'),
  getProjectDir: vi.fn(() => '/workspace/.anodex/skills')
}))

vi.mock('../../skills/SkillStore', () => ({
  skillStore: {
    list: mocks.list,
    get: mocks.get,
    getDir: mocks.getDir,
    getProjectDir: mocks.getProjectDir
  }
}))

type FindHandler = (args: { query: string }) => Promise<string>
type LoadHandler = (args: { name: string }) => Promise<string>

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: 'commit-messages',
    description: 'Write clear, conventional commit messages.',
    scope: 'personal',
    keywords: ['commit', 'git'],
    tools: [],
    body: 'Use imperative mood. Keep the subject line under 72 chars.',
    filePath: '/personal/skills/commit-messages.md',
    ...overrides
  }
}

function context(overrides: Partial<ToolRuntimeContext> = {}): ToolRuntimeContext {
  return { ...createMockContext('/tmp/workspace'), ...overrides }
}

describe('find_skill', () => {
  beforeEach(() => {
    mocks.list.mockReset()
    mocks.get.mockReset()
  })

  it('reports when the catalog has no skills yet', async () => {
    mocks.list.mockReturnValue([])
    const tool = findSkillTool(createMockDefine(), context()) as unknown as { handler: FindHandler }

    const result = await tool.handler({ query: 'commit messages' })
    expect(result).toContain('No skills found yet')
  })

  it('reports when nothing matches the query', async () => {
    mocks.list.mockReturnValue([makeSkill({ name: 'unrelated-thing', keywords: ['xyz'] })])
    const tool = findSkillTool(createMockDefine(), context()) as unknown as { handler: FindHandler }

    const result = await tool.handler({ query: 'quantum teleportation' })
    expect(result).toContain('No matching skills found')
  })

  it('returns ranked matches with scope prefix and description', async () => {
    mocks.list.mockReturnValue([makeSkill()])
    const tool = findSkillTool(createMockDefine(), context()) as unknown as { handler: FindHandler }

    const result = await tool.handler({ query: 'commit messages' })
    expect(result).toContain('[personal] commit-messages')
    expect(result).toContain('Write clear, conventional commit messages.')
  })
})

describe('load_skill', () => {
  beforeEach(() => {
    mocks.list.mockReset()
    mocks.get.mockReset()
  })

  it('returns the full skill body with scope in the heading', async () => {
    mocks.get.mockReturnValue(makeSkill())
    const tool = loadSkillTool(createMockDefine(), context()) as unknown as { handler: LoadHandler }

    const result = await tool.handler({ name: 'commit-messages' })
    expect(result).toContain('# commit-messages (personal skill)')
    expect(result).toContain('Use imperative mood.')
  })

  it('reports an error to the model for an unknown skill name', async () => {
    mocks.get.mockReturnValue(null)
    const tool = loadSkillTool(createMockDefine(), context()) as unknown as { handler: LoadHandler }

    const result = await tool.handler({ name: 'does-not-exist' })
    expect(result).toContain('No skill named "does-not-exist" found')
  })

  it('notes tools the skill expects that are not enabled for this run', async () => {
    mocks.get.mockReturnValue(makeSkill({ tools: ['run_command', 'write_file'] }))
    const tool = loadSkillTool(
      createMockDefine(),
      context({ enabledTools: new Set(['write_file']) })
    ) as unknown as { handler: LoadHandler }

    const result = await tool.handler({ name: 'commit-messages' })
    expect(result).toContain('run_command')
    expect(result).toContain('not enabled for this run')
    expect(result).not.toMatch(/expects.*write_file/)
  })

  it('adds no note when every expected tool is enabled', async () => {
    mocks.get.mockReturnValue(makeSkill({ tools: ['write_file'] }))
    const tool = loadSkillTool(
      createMockDefine(),
      context({ enabledTools: new Set(['write_file', 'run_command']) })
    ) as unknown as { handler: LoadHandler }

    const result = await tool.handler({ name: 'commit-messages' })
    expect(result).not.toContain('not enabled')
  })

  it('adds no note when tool availability is unrestricted (enabledTools is null)', async () => {
    mocks.get.mockReturnValue(makeSkill({ tools: ['run_command'] }))
    const tool = loadSkillTool(createMockDefine(), context({ enabledTools: null })) as unknown as {
      handler: LoadHandler
    }

    const result = await tool.handler({ name: 'commit-messages' })
    expect(result).not.toContain('not enabled')
  })
})
