import { describe, expect, it, vi } from 'vitest'
import { REMOTE_CLIENT } from '@main/clients/clientRegistry'
import { buildRunToolNames } from '@shared/tools.types'

const started: Array<{ enabledTools: string[]; requirePlan?: boolean }> = []
const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, listener)
    }
  }
}))

vi.mock('@main/agents/AgentRunService', () => ({
  agentRunService: {
    start: (request: { enabledTools: string[]; requirePlan?: boolean }) => {
      started.push(request)
      return request
    },
    stop: vi.fn()
  }
}))

vi.mock('@main/agents/AgentRunStore', () => ({
  agentRunStore: { list: () => [], get: () => undefined, delete: vi.fn() }
}))

const { registerAgentHandlers } = await import('../agent.handlers')

/**
 * Starting a build from away is the point of the phone. These cases are about
 * which half of that request the caller gets to decide.
 */
describe('an agent run started from a phone', () => {
  registerAgentHandlers()

  const remote = { [REMOTE_CLIENT]: {} }
  const base = { goal: 'Fix the failing tests', projectId: 'p_1', provider: 'local' as const }

  it('cannot name a tool outside the vetted build set', async () => {
    await handlers.get('agent:create')!(remote, {
      ...base,
      enabledTools: ['read_file', 'send_email', 'not_a_real_tool']
    })

    const tools = started.at(-1)!.enabledTools
    expect(tools).toContain('read_file')
    expect(tools).not.toContain('send_email')
    expect(tools).not.toContain('not_a_real_tool')
  })

  it('cannot switch off the plan gate', async () => {
    // The gate is the human control, and it is the one the phone can actually
    // answer. A run that skipped it would edit real files with no review anywhere.
    await handlers.get('agent:create')!(remote, {
      ...base,
      enabledTools: ['read_file'],
      requirePlan: false
    })

    expect(started.at(-1)!.requirePlan).toBe(true)
  })

  it('gets the desktop default rather than nothing when it asks for nothing usable', async () => {
    await handlers.get('agent:create')!(remote, { ...base, enabledTools: ['send_email'] })

    expect(started.at(-1)!.enabledTools).toEqual(buildRunToolNames())
  })

  it('leaves a run started at the computer exactly as asked', async () => {
    // The editor at the desk shows the tool list and the plan switch on screen.
    await handlers.get('agent:create')!(
      {},
      {
        ...base,
        enabledTools: ['read_file'],
        requirePlan: false
      }
    )

    expect(started.at(-1)!.enabledTools).toEqual(['read_file'])
    expect(started.at(-1)!.requirePlan).toBe(false)
  })
})
