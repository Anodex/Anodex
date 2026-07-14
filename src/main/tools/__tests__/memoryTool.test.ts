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
      memory: { crossChatEnabled: true, personalEnabled: true, confirmBeforeSaving: false }
    })
    expect(scope).toEqual({ type: 'project', projectId: 'project-1' })
  })

  it('returns global scope when requested and personal memory is on', () => {
    const scope = resolveMemoryScope('global', {
      projectId: 'project-1',
      memory: { crossChatEnabled: true, personalEnabled: true, confirmBeforeSaving: false }
    })
    expect(scope).toEqual({ type: 'global' })
  })

  it('falls back to global when project is requested but no project is open', () => {
    const scope = resolveMemoryScope('project', {
      projectId: null,
      memory: { crossChatEnabled: true, personalEnabled: true, confirmBeforeSaving: false }
    })
    expect(scope).toEqual({ type: 'global' })
  })

  it('falls back to global when project is requested but cross-chat memory is off', () => {
    const scope = resolveMemoryScope('project', {
      projectId: 'project-1',
      memory: { crossChatEnabled: false, personalEnabled: true, confirmBeforeSaving: false }
    })
    expect(scope).toEqual({ type: 'global' })
  })

  it('falls back to project when global is requested but personal memory is off', () => {
    const scope = resolveMemoryScope('global', {
      projectId: 'project-1',
      memory: { crossChatEnabled: true, personalEnabled: false, confirmBeforeSaving: false }
    })
    expect(scope).toEqual({ type: 'project', projectId: 'project-1' })
  })

  it('returns null when nothing is available', () => {
    expect(
      resolveMemoryScope('global', {
        projectId: null,
        memory: { crossChatEnabled: false, personalEnabled: false, confirmBeforeSaving: false }
      })
    ).toBeNull()
    expect(
      resolveMemoryScope('project', {
        projectId: 'project-1',
        memory: { crossChatEnabled: false, personalEnabled: false, confirmBeforeSaving: false }
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

    expect(result).toBe('Remembered as project cross-chat memory.')
    expect(requests).toHaveLength(1)
    // The resolved scope is shown before approval, not just noted after.
    expect(requests[0].detail).toContain('Save as project cross-chat memory')
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

    expect(result).toBe('Remembered as global personal memory.')
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'My name is Gabe.', scope: { type: 'global' } })
    )
  })

  it('shows the resolved scope — not the requested one — in the confirmation, before approval', async () => {
    const { requests, confirm } = captureConfirmations()
    const ctx = { ...createMockContext('/workspace'), projectId: null, confirm }
    const tool = rememberFactTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { text: string; kind: string; scope: string }) => Promise<string>
    }

    // Requests 'project' with no project open — resolves to global.
    const result = await tool.handler({ text: 'Some fact.', kind: 'open_task', scope: 'project' })

    expect(requests).toHaveLength(1)
    expect(requests[0].detail).toContain('Save as global personal memory')
    expect(requests[0].detail).toContain("Requested 'project' scope")
    expect(result).toContain('Remembered as global personal memory')
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

  it('saves automatically in a permission mode that would not otherwise confirm a safe tool, when confirmBeforeSaving is off', async () => {
    const { requests, confirm } = captureConfirmations()
    const ctx = {
      ...createMockContext('/workspace'),
      projectId: 'project-1',
      permissionMode: 'full' as const,
      // Pre-approved so this test isolates confirmBeforeSaving's own effect from
      // the separate full-mode "first action" turn gate (see permissions.test.ts).
      turnGate: { approved: true },
      memory: { crossChatEnabled: true, personalEnabled: true, confirmBeforeSaving: false },
      confirm
    }
    const tool = rememberFactTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { text: string; kind: string; scope: string }) => Promise<string>
    }

    await tool.handler({ text: 'Auto-saved fact.', kind: 'convention', scope: 'project' })

    expect(requests).toHaveLength(0)
    expect(createMock).toHaveBeenCalled()
  })

  it('forces confirmation even in a permission mode that would not otherwise ask, when confirmBeforeSaving is on', async () => {
    const { requests, confirm } = captureConfirmations()
    const ctx = {
      ...createMockContext('/workspace'),
      projectId: 'project-1',
      permissionMode: 'full' as const,
      memory: { crossChatEnabled: true, personalEnabled: true, confirmBeforeSaving: true },
      confirm
    }
    const tool = rememberFactTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { text: string; kind: string; scope: string }) => Promise<string>
    }

    await tool.handler({ text: 'Should be confirmed.', kind: 'convention', scope: 'project' })

    expect(requests).toHaveLength(1)
    expect(createMock).toHaveBeenCalled()
  })

  it('rejects when both memory scopes are off', async () => {
    const ctx = {
      ...createMockContext('/workspace'),
      projectId: 'project-1',
      memory: { crossChatEnabled: false, personalEnabled: false, confirmBeforeSaving: false },
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
