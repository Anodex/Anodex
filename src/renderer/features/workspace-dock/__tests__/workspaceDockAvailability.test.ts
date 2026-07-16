import { describe, expect, it } from 'vitest'
import { getWorkspaceDockProjectId } from '../workspaceDockAvailability'

describe('getWorkspaceDockProjectId', () => {
  it('returns the project id only for the active matching project chat', () => {
    expect(
      getWorkspaceDockProjectId({
        view: 'chat',
        activeProjectId: 'project-1',
        activeConversationProjectId: 'project-1'
      })
    ).toBe('project-1')
  })

  it('hides the dock outside chat views', () => {
    expect(
      getWorkspaceDockProjectId({
        view: 'agent',
        activeProjectId: 'project-1',
        activeConversationProjectId: 'project-1'
      })
    ).toBeNull()
  })

  it('hides the dock for general chats', () => {
    expect(
      getWorkspaceDockProjectId({
        view: 'chat',
        activeProjectId: null,
        activeConversationProjectId: null
      })
    ).toBeNull()
  })

  it('hides the dock when the renderer and active workspace are out of sync', () => {
    expect(
      getWorkspaceDockProjectId({
        view: 'chat',
        activeProjectId: 'project-1',
        activeConversationProjectId: 'project-2'
      })
    ).toBeNull()
  })
})
