import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mcpServerStore } from '../McpServerStore'

const mockState = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => mockState.userData }
}))

describe('McpServerStore', () => {
  beforeEach(() => {
    mockState.userData = mkdtempSync(join(tmpdir(), 'anodex-mcp-'))
    mcpServerStore.init()
  })

  afterEach(() => {
    rmSync(mockState.userData, { recursive: true, force: true })
  })

  it('persists local environment names without their secret values', () => {
    const saved = mcpServerStore.add({
      name: 'Private server',
      enabled: false,
      type: 'local',
      command: ['server'],
      environment: { API_TOKEN: 'super-secret-value' }
    })

    expect(saved.type === 'local' ? saved.environmentKeys : []).toEqual(['API_TOKEN'])
    const persisted = readFileSync(join(mockState.userData, 'mcp-servers.json'), 'utf-8')
    expect(persisted).toContain('API_TOKEN')
    expect(persisted).not.toContain('super-secret-value')
  })
})
