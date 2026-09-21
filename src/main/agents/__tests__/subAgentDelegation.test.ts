import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRun, CreateAgentRunRequest } from '@shared/agentRun.types'
import type { Conversation } from '@shared/conversation.types'

/**
 * A parent agent run fanning work out to sub-agents, driven through the real
 * service with only its edges mocked.
 *
 * The pure parts of this feature are tested in `subAgents.test.ts`. What can
 * only be tested here is the wiring, and the wiring is where the damage would
 * be: whether a sub-run clobbers the service lock its parent is holding,
 * whether a child can delegate again, whether a child's spend lands against
 * the budget it was given a slice of, and whether three sub-agents finishing
 * wake the user's phone three times.
 */

interface CapturedTurn {
  runId: string
  enabledTools: Set<string>
  hasDelegate: boolean
}

/*
 * `any` throughout: this drives the real service, whose `runGeneration` takes
 * a request and an io object with a dozen optional fields. Reconstructing
 * those types here would test the reconstruction, not the wiring.
 */
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await */
const runGeneration = vi.fn<(request: any, io: any) => Promise<any>>()
const notifyUser = vi.fn<(...args: unknown[]) => void>()
const broadcastToWindows = vi.fn<(...args: unknown[]) => void>()
let subAgentsEnabled = true

/** Every run the service created, in creation order. */
let runs: AgentRun[] = []
/** Every turn that reached `runGeneration`, so the tool sets can be inspected. */
let turns: CapturedTurn[] = []
/** Conversation id to the run it belongs to, so a turn knows who is speaking. */
const runOfConversation = new Map<string, string>()

vi.mock('../../chat/runGeneration', () => ({
  runGeneration: (request: any, io: any) => runGeneration(request, io)
}))

vi.mock('../AgentRunStore', () => ({
  generateAgentRunId: () => `run_${runs.length + 1}`,
  agentRunStore: {
    create: (
      request: CreateAgentRunRequest,
      prepared: { id?: string; parentRunId?: string; delegatedTask?: string } = {}
    ) => {
      const run: AgentRun = {
        id: prepared.id ?? `run_${runs.length + 1}`,
        ...(prepared.parentRunId ? { parentRunId: prepared.parentRunId } : {}),
        ...(prepared.delegatedTask ? { delegatedTask: prepared.delegatedTask } : {}),
        goal: request.goal,
        status: 'running',
        projectId: request.projectId,
        enabledTools: request.enabledTools,
        provider: request.provider,
        model: request.model ?? null,
        maxTurns: request.maxTurns ?? 8,
        turnsUsed: 0,
        flaggedTurns: 0,
        maxTokens: request.maxTokens ?? 50_000,
        tokensUsed: 0,
        maxDurationMinutes: request.maxDurationMinutes ?? 30,
        activeMs: 0,
        activeSinceAt: null,
        limitsEnabled: request.limitsEnabled ?? true,
        conversationId: null,
        summary: null,
        lastError: null,
        requirePlan: request.requirePlan ?? true,
        plan: null,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
      runs.push(run)
      return run
    },
    get: (id: string) => runs.find((run) => run.id === id),
    update: (id: string, patch: Partial<AgentRun>) => {
      const index = runs.findIndex((run) => run.id === id)
      if (index < 0) throw new Error(`No such run: ${id}`)
      runs[index] = { ...runs[index], ...patch }
      return runs[index]
    },
    list: () => runs,
    remove: vi.fn()
  }
}))

const conversations = new Map<string, Conversation>()
vi.mock('../../conversations/ConversationStore', () => ({
  conversationStore: {
    get: (id: string) => conversations.get(id),
    save: (conversation: Conversation) => conversations.set(conversation.id, conversation),
    listAll: () => [...conversations.values()],
    list: () => [...conversations.values()]
  }
}))

vi.mock('../../conversations/backgroundTurn', () => ({
  appendBackgroundTurn: (conversation: Conversation, messages: unknown[]) => ({
    ...conversation,
    messages: [...conversation.messages, ...(messages as Conversation['messages'])]
  })
}))

vi.mock('../agentRunAttachments', () => ({
  importRunAttachments: async () => [],
  discardRunAttachments: async () => {},
  attachmentsForTurn: async (_attachments: unknown, _history: unknown, prompt: string) => ({
    prompt,
    images: undefined,
    attachments: undefined
  })
}))

vi.mock('../../broadcast', () => ({
  broadcastToWindows: (...args: unknown[]) => broadcastToWindows(...args)
}))
vi.mock('../../notify', () => ({
  notifyUser: (...args: unknown[]) => notifyUser(...args),
  notifyRemoteClients: vi.fn()
}))
vi.mock('../../toastWindow', () => ({ showToastWindow: vi.fn() }))
vi.mock('../../settings/SettingsStore', () => ({
  settingsStore: {
    get: () => ({
      general: { permissionMode: 'ask' },
      generation: { turnTimeLimitMinutes: 0 },
      agents: { subAgentsEnabled }
    })
  }
}))
vi.mock('../../utils/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

const { agentRunService } = await import('../AgentRunService')

/** Track which run each conversation belongs to as the service creates them. */
function linkConversations(): void {
  for (const run of runs) {
    if (run.conversationId) runOfConversation.set(run.conversationId, run.id)
  }
}

function noteTurn(request: any, io: any): string {
  linkConversations()
  const runId = runOfConversation.get(request.conversationId) ?? 'unknown'
  turns.push({
    runId,
    enabledTools: new Set<string>(io.enabledTools ?? []),
    hasDelegate: typeof io.delegate === 'function'
  })
  return runId
}

function finished(io: any, detail: string, tokens: number): any {
  io.onActivity?.({
    id: `call_${turns.length}`,
    name: 'finish_goal',
    status: 'success',
    detail
  })
  return { content: detail, stats: { tokens }, stopped: false }
}

async function startAndSettle(request: Partial<CreateAgentRunRequest> = {}): Promise<AgentRun> {
  const started = await agentRunService.start({
    goal: 'Find the bugs',
    projectId: null,
    enabledTools: ['read_file', 'grep_files'],
    provider: 'local',
    requirePlan: false,
    ...request
  })
  // `start` kicks the loop off without awaiting it, and the delegation inside
  // it awaits whole further runs — settle over many ticks rather than one.
  for (let tick = 0; tick < 80; tick++) await new Promise((resolve) => setTimeout(resolve, 0))
  return started
}

beforeEach(() => {
  runs = []
  turns = []
  conversations.clear()
  runOfConversation.clear()
  subAgentsEnabled = true
  runGeneration.mockReset()
  notifyUser.mockReset()
  broadcastToWindows.mockReset()
})

describe('a run that delegates', () => {
  /**
   * The parent's first turn delegates, its second finishes, and each child
   * reports once. Returns an accessor for what the parent got back.
   */
  function delegateOnce(tasks: string[], childSummaries: Record<string, string> = {}) {
    let delegated = false
    let reports: unknown
    runGeneration.mockImplementation(async (request: any, io: any) => {
      const runId = noteTurn(request, io)
      const run = runs.find((entry) => entry.id === runId)

      if (run?.parentRunId) {
        const summary = childSummaries[run.goal] ?? `Checked ${run.goal}`
        if (summary === 'THROW') throw new Error('sub-agent exploded')
        return finished(io, summary, 500)
      }
      if (!delegated) {
        delegated = true
        reports = await io.delegate(tasks)
        return { content: 'delegated', stats: { tokens: 100 }, stopped: false }
      }
      return finished(io, 'Collated what the sub-agents found.', 100)
    })
    return () =>
      reports as { task: string; runId: string; status: string; report: string }[] | undefined
  }

  it('creates one real, supervisable run per task', async () => {
    // Not a row inside the parent's tool result: a run with its own record
    // and transcript is the only kind anyone can watch, stop or read after.
    delegateOnce(['check auth', 'check parsing'])
    const parent = await startAndSettle()

    const children = runs.filter((run) => run.parentRunId === parent.id)
    expect(children).toHaveLength(2)
    expect(children.map((child) => child.goal)).toEqual(['check auth', 'check parsing'])
    expect(children.map((child) => child.delegatedTask)).toEqual(['check auth', 'check parsing'])
    expect(children.every((child) => child.conversationId)).toBe(true)
  })

  it('gives a sub-agent no way to delegate again', async () => {
    // One level of fan-out is a feature; recursion is a fork bomb with an API
    // bill. Both guards are asserted: the capability and the tool set.
    delegateOnce(['check auth'])
    const parent = await startAndSettle()

    const childTurns = turns.filter((turn) => turn.runId !== parent.id && turn.runId !== 'unknown')
    expect(childTurns.length).toBeGreaterThan(0)
    for (const turn of childTurns) {
      expect(turn.hasDelegate).toBe(false)
      expect(turn.enabledTools.has('delegate')).toBe(false)
    }
  })

  it('never grants a sub-agent a tool its parent lacked', async () => {
    delegateOnce(['check auth'])
    const parent = await startAndSettle({ enabledTools: ['read_file'] })

    const child = runs.find((run) => run.parentRunId === parent.id)
    expect(child?.enabledTools).toContain('read_file')
    expect(child?.enabledTools).not.toContain('write_file')
    expect(child?.enabledTools).not.toContain('run_command')
  })

  it('reports each sub-agent’s own summary back to the parent', async () => {
    const getReports = delegateOnce(['check auth', 'check parsing'], {
      'check auth': 'Unchecked null on line 40.',
      'check parsing': 'Nothing obvious.'
    })
    await startAndSettle()

    // The child's own stored summary, which is its closing statement joined
    // to the settled account of what it actually did — the parent should read
    // a claim beside its record, not the claim alone.
    expect(getReports()?.[0].report).toContain('Unchecked null on line 40.')
    expect(getReports()?.[1].report).toContain('Nothing obvious.')
    expect(getReports()?.every((report) => report.status === 'done')).toBe(true)
  })

  it('keeps the other branches when one sub-agent fails', async () => {
    // One failed branch of an investigation is a result the parent should see
    // and work around, not a reason to lose the two that succeeded.
    const getReports = delegateOnce(['ok one', 'bad', 'ok two'], { bad: 'THROW' })
    await startAndSettle()

    const reports = getReports()
    expect(reports).toHaveLength(3)
    expect(reports?.[1].status).toBe('error')
    expect(reports?.[0].status).toBe('done')
    expect(reports?.[2].status).toBe('done')
  })

  it('does not release the service lock when a sub-run finishes', async () => {
    // The bug this guards: a sub-run taking the lock overwrites its parent's
    // entry and then clears it on its own `finally`, leaving `stop()` aimed at
    // a run that already ended and `isRunning()` false while one still is.
    delegateOnce(['check auth', 'check parsing'])
    await startAndSettle()

    expect(agentRunService.isRunning()).toBe(false)
    // The parent got a second turn after its children finished, which it could
    // not have if the lock had been lost underneath it.
    expect(turns.filter((turn) => turn.runId === 'run_1')).toHaveLength(2)
  })

  it('charges the sub-agents’ tokens to the run that delegated them', async () => {
    // They were paid for out of this run's budget — `splitRunBudget` hands
    // each of them a slice of it. Without folding them back, the parent would
    // keep spending as though the delegation had been free.
    delegateOnce(['check auth', 'check parsing'])
    const parent = await startAndSettle()

    // 100 (the delegating turn) + 500 + 500 (children) + 100 (the last turn).
    expect(runs.find((run) => run.id === parent.id)?.tokensUsed).toBe(1_200)
  })

  it('still records what sub-agents spent when the turn then fails', async () => {
    // The delegation returns, and the turn dies on the way out — a provider
    // dropping, say. The children's tokens were really spent and are really
    // billed, so losing them would leave the run under-reporting its own cost
    // at exactly the moment someone goes looking for why it stopped.
    runGeneration.mockImplementation(async (request: any, io: any) => {
      noteTurn(request, io)
      const runId = runOfConversation.get(request.conversationId) ?? 'unknown'
      const run = runs.find((entry) => entry.id === runId)
      if (run?.parentRunId) return finished(io, `Checked ${run.goal}`, 500)
      await io.delegate(['check auth', 'check parsing'])
      throw new Error('ENOTFOUND api.anthropic.com')
    })
    const parent = await startAndSettle()

    const finishedRun = runs.find((run) => run.id === parent.id)
    expect(finishedRun?.status).toBe('error')
    expect(finishedRun?.tokensUsed).toBe(1_000)
  })

  it('divides the parent’s budget rather than multiplying it', async () => {
    delegateOnce(['a', 'b'])
    const parent = await startAndSettle({ maxTurns: 10, maxTokens: 40_000 })

    const children = runs.filter((run) => run.parentRunId === parent.id)
    // The parent was on turn 1 of 10 when it delegated, so (10-1)/2 each.
    expect(children.every((child) => child.maxTurns === 4)).toBe(true)
    // Its own in-flight turn has not been banked yet — a turn's tokens are
    // not known until it returns, and it has not returned: it is blocked
    // inside this very delegation. So the split divides all 40,000.
    expect(children.every((child) => child.maxTokens === 20_000)).toBe(true)
  })

  it('does not wake the user once per sub-agent', async () => {
    // Three of these on a lock screen, followed by the parent's own, is how a
    // useful notification becomes one people switch off.
    delegateOnce(['a', 'b', 'c'])
    await startAndSettle()

    expect(notifyUser).toHaveBeenCalledTimes(1)
  })

  it('refuses a delegation the remaining budget cannot cover', async () => {
    let refusal: string | null = null
    runGeneration.mockImplementation(async (request: any, io: any) => {
      noteTurn(request, io)
      if (io.delegate) {
        try {
          await io.delegate(['a', 'b', 'c'])
        } catch (error) {
          refusal = error instanceof Error ? error.message : String(error)
        }
      }
      return finished(io, 'Stopped.', 10)
    })
    await startAndSettle({ maxTurns: 2 })

    // A refusal, not an empty report list — which would read to the model as
    // "the sub-agents found nothing".
    expect(refusal).toMatch(/not enough turns/i)
    expect(runs.filter((run) => run.parentRunId)).toHaveLength(0)
  })
})

describe('when sub-agents are switched off', () => {
  it('offers the capability to no one', async () => {
    // Off by default: a goal that quietly became four runs is not what
    // someone pressing Start agreed to.
    subAgentsEnabled = false
    runGeneration.mockImplementation(async (request: any, io: any) => {
      noteTurn(request, io)
      return finished(io, 'Done', 100)
    })
    await startAndSettle()

    expect(turns).toHaveLength(1)
    expect(turns[0].hasDelegate).toBe(false)
    expect(turns[0].enabledTools.has('delegate')).toBe(false)
  })
})
