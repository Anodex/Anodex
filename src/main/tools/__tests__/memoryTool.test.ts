import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { CreateMemoryRequest, MemoryEntry } from '@shared/memory.types'
import { rememberFactTool, resolveMemoryScope } from '../memoryTool'
import {
  captureCalls,
  captureConfirmations,
  createMockContext,
  createMockDefine
} from './test-helpers'

const createMock = vi.fn<(request: CreateMemoryRequest) => MemoryEntry>()

// Hoisted above the import of `memoryTool`, so it picks up this mock instead
// of touching disk through the real singleton (uninitialized in tests).
vi.mock('../../memory/MemoryStore', () => ({
  MAX_MEMORY_TEXT_CHARS: 400,
  normalizeMemoryText: (text: string) => text.trim().slice(0, 400),
  memoryStore: { create: (request: CreateMemoryRequest) => createMock(request) }
}))

describe('resolveMemoryScope', () => {
  it('returns project scope when requested and cross-chat memory is on', () => {
    const scope = resolveMemoryScope('project', {
      projectId: 'project-1',
      memory: { crossChatEnabled: true, personalEnabled: true }
    })
    expect(scope).toEqual({ type: 'project', projectId: 'project-1' })
  })

  it('returns global scope when requested and personal memory is on', () => {
    const scope = resolveMemoryScope('global', {
      projectId: 'project-1',
      memory: { crossChatEnabled: true, personalEnabled: true }
    })
    expect(scope).toEqual({ type: 'global' })
  })

  it('falls back to global when project is requested but no project is open', () => {
    const scope = resolveMemoryScope('project', {
      projectId: null,
      memory: { crossChatEnabled: true, personalEnabled: true }
    })
    expect(scope).toEqual({ type: 'global' })
  })

  it('falls back to global when project is requested but cross-chat memory is off', () => {
    const scope = resolveMemoryScope('project', {
      projectId: 'project-1',
      memory: { crossChatEnabled: false, personalEnabled: true }
    })
    expect(scope).toEqual({ type: 'global' })
  })

  it('falls back to project when global is requested but personal memory is off', () => {
    const scope = resolveMemoryScope('global', {
      projectId: 'project-1',
      memory: { crossChatEnabled: true, personalEnabled: false }
    })
    expect(scope).toEqual({ type: 'project', projectId: 'project-1' })
  })

  it('returns null when nothing is available', () => {
    expect(
      resolveMemoryScope('global', {
        projectId: null,
        memory: { crossChatEnabled: false, personalEnabled: false }
      })
    ).toBeNull()
    expect(
      resolveMemoryScope('project', {
        projectId: 'project-1',
        memory: { crossChatEnabled: false, personalEnabled: false }
      })
    ).toBeNull()
  })
})

describe('remember_fact tool', () => {
  beforeEach(() => {
    createMock.mockReset()
    createMock.mockImplementation((request) => ({
      id: 'm1',
      ...request,
      createdAt: 0,
      updatedAt: 0,
      pinned: false,
      archived: false
    }))
  })

  it('records a project-scoped memory after approval', async () => {
    const { requests, confirm } = captureConfirmations()
    const ctx = { ...createMockContext('/workspace'), projectId: 'project-1', confirm }
    const tool = rememberFactTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { text: string; kind: string; scope: string }) => Promise<string>
    }

    const result = await tool.handler({
      text: 'Uses pnpm, not npm.',
      kind: 'convention',
      scope: 'project'
    })

    expect(result).toBe('Remembered.')
    expect(requests).toHaveLength(1)
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'convention',
        text: 'Uses pnpm, not npm.',
        scope: { type: 'project', projectId: 'project-1' },
        source: { conversationId: 'test-conversation' }
      })
    )
  })

  it('records a global-scoped memory with no project or workspace open', async () => {
    // The scenario that used to be completely broken: a plain chat with no
    // project telling the assistant something personal.
    const ctx = {
      ...createMockContext('/workspace'),
      workspaceRoot: null,
      projectId: null,
      confirm: () => Promise.resolve({ approved: true })
    }
    const tool = rememberFactTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { text: string; kind: string; scope: string }) => Promise<string>
    }

    const result = await tool.handler({
      text: 'My name is Gabe.',
      kind: 'preference',
      scope: 'global'
    })

    expect(result).toBe('Remembered.')
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'My name is Gabe.', scope: { type: 'global' } })
    )
  })

  it('notes the scope fallback in the model-facing result when the requested scope is unavailable', async () => {
    const ctx = {
      ...createMockContext('/workspace'),
      projectId: null,
      confirm: () => Promise.resolve({ approved: true })
    }
    const tool = rememberFactTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { text: string; kind: string; scope: string }) => Promise<string>
    }

    // Requests 'project' with no project open — silently falls back to global.
    const result = await tool.handler({ text: 'Some fact.', kind: 'open_task', scope: 'project' })

    expect(result).toContain('saved as global')
  })

  it('truncates text at the max length', async () => {
    const ctx = {
      ...createMockContext('/workspace'),
      projectId: 'project-1',
      confirm: () => Promise.resolve({ approved: true })
    }
    const tool = rememberFactTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { text: string; kind: string; scope: string }) => Promise<string>
    }

    await tool.handler({ text: 'x'.repeat(500), kind: 'gotcha', scope: 'global' })

    const saved = createMock.mock.calls[0][0]
    expect(saved.text).toHaveLength(400)
  })

  it('reports a denial without calling the store', async () => {
    const ctx = {
      ...createMockContext('/workspace'),
      projectId: 'project-1',
      confirm: () => Promise.resolve({ approved: false, reason: 'not now' })
    }
    const tool = rememberFactTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { text: string; kind: string; scope: string }) => Promise<string>
    }

    const result = await tool.handler({ text: 'Something.', kind: 'preference', scope: 'global' })

    expect(result).toContain('not now')
    expect(createMock).not.toHaveBeenCalled()
  })

  it('emits a success event with a short detail', async () => {
    const capture = captureCalls()
    const ctx = {
      ...createMockContext('/workspace'),
      projectId: 'project-1',
      emit: capture.emit,
      confirm: () => Promise.resolve({ approved: true })
    }
    const tool = rememberFactTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { text: string; kind: string; scope: string }) => Promise<string>
    }

    await tool.handler({ text: 'Short fact.', kind: 'open_task', scope: 'project' })

    const success = capture.calls.find((c) => c.status === 'success')
    expect(success?.detail).toBe('Short fact.')
  })

  it('rejects when both memory scopes are off', async () => {
    const ctx = {
      ...createMockContext('/workspace'),
      projectId: 'project-1',
      memory: { crossChatEnabled: false, personalEnabled: false },
      confirm: () => Promise.resolve({ approved: true })
    }
    const tool = rememberFactTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { text: string; kind: string; scope: string }) => Promise<string>
    }

    const result = await tool.handler({ text: 'Something.', kind: 'preference', scope: 'global' })

    expect(result).toContain('turned off')
    expect(createMock).not.toHaveBeenCalled()
  })
})
