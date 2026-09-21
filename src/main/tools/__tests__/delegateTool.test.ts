import { describe, expect, it, vi } from 'vitest'
import { delegateTool } from '../delegateTool'
import { buildTools } from '../registry'
import type { ToolRuntimeContext } from '../types'
import type { SubAgentReport } from '@shared/subAgents'
import { createMockContext, createMockDefine } from './test-helpers'

/**
 * The `delegate` tool and, more importantly, the rule that decides whether it
 * exists at all.
 *
 * Registration is the permission here. There is no prompt telling a run not
 * to delegate and no check inside the tool asking whether it is allowed —
 * `AgentRunService` either supplies the capability or it does not, and
 * everything downstream follows from that. Which makes "when does this get
 * registered" the security-relevant question, not a wiring detail.
 */

type DelegateHandler = (args: { tasks: string[] }) => Promise<string>

function contextWith(delegate?: ToolRuntimeContext['delegate']): ToolRuntimeContext {
  return { ...createMockContext('/tmp/workspace'), delegate }
}

function handlerFor(ctx: ToolRuntimeContext): DelegateHandler {
  return (delegateTool(createMockDefine(), ctx) as unknown as { handler: DelegateHandler }).handler
}

const report = (overrides: Partial<SubAgentReport> = {}): SubAgentReport => ({
  task: 'check the auth module',
  runId: 'run-1',
  status: 'done',
  report: 'Found an unchecked null on line 40.',
  ...overrides
})

describe('registering delegate', () => {
  it('is absent from an ordinary chat turn', () => {
    // A chat is never handed the capability, so the tool it would need
    // simply is not there — not disabled, not refused at call time, absent.
    expect(buildTools(createMockDefine(), contextWith())).not.toHaveProperty('delegate')
  })

  it('appears once a caller supplies the capability', () => {
    const ctx = contextWith(() => Promise.resolve([]))
    expect(buildTools(createMockDefine(), ctx)).toHaveProperty('delegate')
  })

  it('stays absent for a run whose tool list excludes it', () => {
    // A sub-agent's tool set is built by `subAgentTools`, which strips
    // `delegate` — so even if the capability leaked through, the allowlist
    // is a second, independent refusal. One level of fan-out is a feature;
    // recursion is a fork bomb with an API bill.
    const ctx = {
      ...contextWith(() => Promise.resolve([])),
      enabledTools: new Set(['read_file', 'finish_goal'])
    }
    expect(buildTools(createMockDefine(), ctx)).not.toHaveProperty('delegate')
  })

  it('respects the user disabling it like any other tool', () => {
    const ctx = { ...contextWith(() => Promise.resolve([])), disabledTools: new Set(['delegate']) }
    expect(buildTools(createMockDefine(), ctx)).not.toHaveProperty('delegate')
  })
})

describe('delegate', () => {
  it('hands the tasks over and returns what came back', async () => {
    const delegate = vi.fn(() =>
      Promise.resolve([
        report({ task: 'auth' }),
        report({ task: 'parsing', report: 'Nothing obvious.' })
      ])
    )
    const result = await handlerFor(contextWith(delegate))({ tasks: ['auth', 'parsing'] })

    expect(delegate).toHaveBeenCalledWith(['auth', 'parsing'])
    expect(result).toContain('Found an unchecked null on line 40.')
    expect(result).toContain('Nothing obvious.')
  })

  it('refuses more sub-agents than the machine can run at once', async () => {
    const delegate = vi.fn(() => Promise.resolve([]))
    const result = await handlerFor(contextWith(delegate))({ tasks: ['a', 'b', 'c', 'd'] })

    expect(result).toContain('Error')
    expect(result).toMatch(/3 is the most/)
    // Nothing was started: the refusal happens before anything is spent.
    expect(delegate).not.toHaveBeenCalled()
  })

  it('refuses a delegation with nothing in it', async () => {
    const delegate = vi.fn(() => Promise.resolve([]))
    const result = await handlerFor(contextWith(delegate))({ tasks: ['', '   '] })

    expect(result).toContain('Error')
    expect(delegate).not.toHaveBeenCalled()
  })

  it('passes a sub-agent’s failure back rather than hiding it', async () => {
    // The parent has to be able to tell "nothing found" from "it never
    // reported", because those lead to different next moves.
    const delegate = vi.fn(() => Promise.resolve([report({ status: 'error', report: '' })]))
    const result = await handlerFor(contextWith(delegate))({ tasks: ['auth'] })

    expect(result).toMatch(/reported nothing/i)
    expect(result).toContain('error')
  })

  it('fails loudly if it is somehow called without the capability', async () => {
    // Unreachable through registration, which is the point — a tool that
    // could run without its capability would fail deep inside a run with
    // nothing useful to say.
    const result = await handlerFor(contextWith())({ tasks: ['auth'] })

    expect(result).toContain('Error')
    expect(result).toMatch(/cannot use sub-agents/i)
  })
})
