import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRun, CreateAgentRunRequest } from '@shared/agentRun.types'
import type { Conversation } from '@shared/conversation.types'
import type { SubAgentReport } from '@shared/subAgents'

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
/** Generation slots the local engine has; the parent occupies one. */
let parallelJobs = 1
/** Where each sub-agent runs; empty means it inherits the parent's provider. */
let subAgentProviders: string[] = []
/**
 * Whether the settings file still has its provider block.
 *
 * Real files have lost one — a partial write, a hand edit, a migration that
 * did not finish. `isConfigured` reaches straight into it, so the absence
 * throws rather than reading as "nothing configured".
 */
let providerBlockPresent = true
/**
 * Turns a *sub-agent* starts life already having flagged.
 *
 * Set on creation rather than mid-run because the service reads
 * `run.flaggedTurns` once when its loop starts and is authoritative from
 * then on — mutating the record mid-turn is simply overwritten, which is
 * correct and makes creation the only honest seam for a test.
 */
let childStartsFlagged = 0

/**
 * A complete provider block, because `agentRunProviderOptions` asks every
 * provider whether it is configured and a missing group throws. Only
 * DeepSeek has a key, so it is the only cloud provider a sub-agent can
 * actually be sent to — which is what the stale-provider test relies on.
 */
function providerSettings(): Record<string, unknown> {
  const ids = [
    'anthropic',
    'openai',
    'google',
    'xai',
    'deepseek',
    'mistral',
    'groq',
    'openrouter',
    'azure',
    'kimi',
    'qwen'
  ]
  const block: Record<string, unknown> = { active: 'local' }
  for (const id of ids) {
    block[id] =
      id === 'deepseek'
        ? { apiKey: 'sk-test', model: 'deepseek-chat' }
        : id === 'openai'
          ? // A second configured provider, so the wrap-around across
            // *different* vendors can be exercised end to end. Anthropic
            // stays unconfigured — the stale-provider tests rely on it.
            { apiKey: 'sk-openai', model: 'gpt-5' }
          : { apiKey: '', model: '' }
  }
  return block
}

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
        flaggedTurns: prepared.parentRunId ? childStartsFlagged : 0,
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
      // The local ceiling is parallelJobs - 1, so this decides whether a
      // local run may delegate at all. Cloud runs ignore it.
      model: { parallelJobs },
      provider: providerBlockPresent ? providerSettings() : ({} as Record<string, unknown>),
      agents: { subAgentsEnabled, subAgentProviders }
    })
  }
}))
const appendRunToJournal = vi.fn<(run: AgentRun) => void>()
vi.mock('../agentJournal', () => ({
  appendRunToJournal: (run: AgentRun) => appendRunToJournal(run),
  readJournal: () => null
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
    // Cloud: delegation is refused on the local engine, where it deadlocks.
    provider: 'anthropic',
    model: 'claude-sonnet-5',
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
  parallelJobs = 1
  subAgentProviders = []
  childStartsFlagged = 0
  providerBlockPresent = true
  appendRunToJournal.mockReset()
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

describe('where each sub-agent runs', () => {
  it('starts each child on its configured provider', () => {
    subAgentsEnabled = true
    subAgentProviders = ['deepseek']
    let delegated = false
    runGeneration.mockImplementation(async (request: any, io: any) => {
      const runId = noteTurn(request, io)
      const run = runs.find((entry) => entry.id === runId)
      if (run?.parentRunId) return finished(io, 'Checked it', 500)
      if (!delegated && io.delegate) {
        delegated = true
        await io.delegate(['check auth'])
        return { content: 'delegated', stats: { tokens: 100 }, stopped: false }
      }
      return finished(io, 'Done', 100)
    })
    return startAndSettle({ provider: 'local' }).then(() => {
      const child = runs.find((run) => run.parentRunId)
      expect(child?.provider).toBe('deepseek')
      // The provider's own configured model, not the parent's and not null:
      // a run with neither a model nor provenance has no record of what
      // produced its findings.
      expect(child?.model).toBe('deepseek-chat')
    })
  })

  it('ignores a provider whose key has since been removed', () => {
    // Chosen while configured, then the key was cleared. Starting a child
    // there would create a run that occupies a slot and cannot generate.
    subAgentsEnabled = true
    subAgentProviders = ['anthropic']
    let delegated = false
    runGeneration.mockImplementation(async (request: any, io: any) => {
      const runId = noteTurn(request, io)
      const run = runs.find((entry) => entry.id === runId)
      if (run?.parentRunId) return finished(io, 'Checked it', 500)
      if (!delegated && io.delegate) {
        delegated = true
        await io.delegate(['check auth'])
        return { content: 'delegated', stats: { tokens: 100 }, stopped: false }
      }
      return finished(io, 'Done', 100)
    })
    return startAndSettle({ provider: 'deepseek' }).then(() => {
      const child = runs.find((run) => run.parentRunId)
      // Falls back to the parent rather than failing.
      expect(child?.provider).toBe('deepseek')
    })
  })

  it('counts the slots that fallback will actually need, not the ones asked for', async () => {
    // The dangerous shape of the case above. A local parent with a cloud
    // child was allowed the full three, because no child was local — and
    // then the key was cleared, every child fell back to the parent, and
    // three local children went looking for the one free slot the parent was
    // not already holding. That is the deadlock `maxSubAgentsFor` exists to
    // prevent, arrived at through the fallback that prevents a different one.
    //
    // Refused rather than trimmed to fit, which is `validateDelegation`'s
    // rule throughout: the model is told the real ceiling and can re-plan,
    // where quietly dropping the third task loses work without saying so.
    subAgentsEnabled = true
    subAgentProviders = ['anthropic'] // chosen, then its key was cleared
    parallelJobs = 2 // the parent holds one; exactly one is free
    let refusal: string | null = null
    let accepted = 0
    runGeneration.mockImplementation(async (request: any, io: any) => {
      const runId = noteTurn(request, io)
      const run = runs.find((entry) => entry.id === runId)
      if (run?.parentRunId) return finished(io, 'Checked it', 500)
      if (refusal === null && io.delegate) {
        try {
          await io.delegate(['check auth', 'check parsing', 'check config'])
        } catch (error) {
          refusal = error instanceof Error ? error.message : String(error)
        }
        return { content: 'delegated', stats: { tokens: 100 }, stopped: false }
      }
      if (accepted === 0 && io.delegate) {
        accepted = ((await io.delegate(['check auth'])) as unknown[]).length
        return { content: 'delegated', stats: { tokens: 100 }, stopped: false }
      }
      return finished(io, 'Done', 100)
    })

    await startAndSettle({ provider: 'local' })

    expect(refusal).toMatch(/1 is the most/)
    // And the one it is allowed does start, so the ceiling narrowed the
    // fan-out rather than switching delegation off.
    expect(accepted).toBe(1)
    const children = runs.filter((run) => run.parentRunId)
    expect(children).toHaveLength(1)
    expect(children[0].provider).toBe('local')
  })
})

describe('a sub-agent whose own turns were flagged', () => {
  it('reports the count back, so the parent does not build on it unwarned', async () => {
    // `flaggedTurns` is how a run records that it described an outcome that
    // did not happen. The parent is a model and will treat a sub-agent's
    // report the way it would treat a file it had read, so the count has to
    // travel with the report rather than staying on the child's record where
    // only a person looking at the panel would see it.
    subAgentsEnabled = true
    childStartsFlagged = 2
    let reports: SubAgentReport[] = []
    let delegated = false
    runGeneration.mockImplementation(async (request: any, io: any) => {
      const runId = noteTurn(request, io)
      const run = runs.find((entry) => entry.id === runId)
      if (run?.parentRunId) return finished(io, 'Rewrote the config', 500)
      if (!delegated && io.delegate) {
        delegated = true
        reports = (await io.delegate(['check auth'])) as SubAgentReport[]
        return { content: 'delegated', stats: { tokens: 100 }, stopped: false }
      }
      return finished(io, 'Done', 100)
    })

    await startAndSettle({ provider: 'anthropic', model: 'claude-sonnet-5' })

    expect(reports[0].flaggedTurns).toBe(2)
  })
})

describe('sub-agents spread across different vendors', () => {
  it('wraps the provider list and gives each child that vendor’s own model', async () => {
    // Two providers, three sub-agents: the third wraps back to the first.
    // Worth an end-to-end case because two things have to agree — which
    // vendor a slot lands on, and which model id means anything to it. A
    // model name carried across vendors is a run that cannot start.
    subAgentsEnabled = true
    subAgentProviders = ['deepseek', 'openai']
    let delegated = false
    runGeneration.mockImplementation(async (request: any, io: any) => {
      const runId = noteTurn(request, io)
      const run = runs.find((entry) => entry.id === runId)
      if (run?.parentRunId) return finished(io, 'Checked it', 500)
      if (!delegated && io.delegate) {
        delegated = true
        await io.delegate(['check auth', 'check parsing', 'check config'])
        return { content: 'delegated', stats: { tokens: 100 }, stopped: false }
      }
      return finished(io, 'Done', 100)
    })

    await startAndSettle({ provider: 'local' })

    const children = runs.filter((run) => run.parentRunId)
    expect(children.map((child) => child.provider)).toEqual(['deepseek', 'openai', 'deepseek'])
    expect(children.map((child) => child.model)).toEqual([
      'deepseek-chat',
      'gpt-5',
      'deepseek-chat'
    ])
  })
})

describe('a run that delegates more than once', () => {
  it('may fan out again, against what is left of its budget', async () => {
    // Nothing forbids a second delegation and nothing should: a parent that
    // has read three reports and found a fourth question worth asking is the
    // feature working. What bounds it is the budget — `splitRunBudget`
    // divides what is *left*, so the second round is smaller than the first,
    // and eventually there is not enough to start one at all.
    subAgentsEnabled = true
    const rounds: number[] = []
    let round = 0
    runGeneration.mockImplementation(async (request: any, io: any) => {
      const runId = noteTurn(request, io)
      const run = runs.find((entry) => entry.id === runId)
      if (run?.parentRunId) return finished(io, 'Checked it', 500)
      if (round < 2 && io.delegate) {
        round++
        const reports = (await io.delegate([`round ${round}`])) as SubAgentReport[]
        rounds.push(reports.length)
        return { content: 'delegated', stats: { tokens: 100 }, stopped: false }
      }
      return finished(io, 'Done', 100)
    })

    await startAndSettle({ provider: 'anthropic', model: 'claude-sonnet-5' })

    expect(rounds).toEqual([1, 1])
    const children = runs.filter((entry) => entry.parentRunId)
    expect(children.map((child) => child.goal)).toEqual(['round 1', 'round 2'])
    // The second child is given less than the first, because the first has
    // already spent part of the run's allowance.
    expect(children[1].maxTokens).toBeLessThan(children[0].maxTokens)
    // And every token either of them spent is charged to the parent.
    const parent = runs.find((entry) => !entry.parentRunId)!
    expect(parent.tokensUsed).toBeGreaterThanOrEqual(1000)
  })
})

describe('when the settings file is missing its provider block', () => {
  it('runs without sub-agents rather than failing to start', async () => {
    // `canDelegate` asks for the ceiling on the first turn, and the ceiling
    // now consults the provider settings to see which chosen children this
    // install can still authenticate as. A throw on that path turns "no
    // sub-agents" into "the run failed", which is the outcome the defaulting
    // around it was written to avoid — so the read has to fail soft.
    subAgentsEnabled = true
    subAgentProviders = ['deepseek']
    providerBlockPresent = false
    runGeneration.mockImplementation(async (request: any, io: any) => {
      noteTurn(request, io)
      return finished(io, 'Done', 100)
    })

    const started = await startAndSettle({ provider: 'anthropic', model: 'claude-sonnet-5' })

    const run = runs.find((entry) => entry.id === started.id)!
    expect(run.status).toBe('done')
    expect(runs.filter((entry) => entry.parentRunId)).toHaveLength(0)
  })
})

describe('stopping a delegation', () => {
  /**
   * Set up a parent that delegates two tasks, and hand back the signals each
   * sub-agent is running under. The callback fires inside the first child's
   * first turn, which is the only moment a delegation is genuinely in flight.
   */
  function delegatingRun(whileInFlight: (parentId: string) => void) {
    const signals = new Map<string, AbortSignal>()
    let parentId = ''
    let delegated = false
    let acted = false
    runGeneration.mockImplementation(async (request: any, io: any) => {
      const runId = noteTurn(request, io)
      const run = runs.find((entry) => entry.id === runId)
      if (run?.parentRunId) {
        signals.set(runId, io.signal)
        if (!acted) {
          acted = true
          whileInFlight(parentId)
        }
        // A real transport returns from an aborted generation without having
        // produced anything; the loop reads that as a terminal stop.
        if (io.signal?.aborted) {
          return { content: '', stats: { tokens: 0 }, stopped: true, stopReason: 'user' }
        }
        return finished(io, 'Checked it', 500)
      }
      parentId = runId
      if (!delegated && io.delegate) {
        delegated = true
        await io.delegate(['check auth', 'check parsing'])
        return { content: 'delegated', stats: { tokens: 100 }, stopped: false }
      }
      if (io.signal?.aborted) {
        return { content: '', stats: { tokens: 0 }, stopped: true, stopReason: 'user' }
      }
      return finished(io, 'Done', 100)
    })
    return { signals, parentId: () => parentId }
  }

  it('stops every sub-agent when the parent is stopped', async () => {
    // The scariest failure an unattended feature can have is work that
    // carries on after you told it to stop. A parent blocked inside
    // `delegate` is not the one doing the work — its children are — so
    // stopping it has to reach them or Stop means nothing here.
    const { signals } = delegatingRun((parentId) => agentRunService.stop(parentId))
    await startAndSettle({ provider: 'anthropic', model: 'claude-sonnet-5' })

    expect(signals.size).toBe(2)
    for (const signal of signals.values()) expect(signal.aborted).toBe(true)
    const children = runs.filter((run) => run.parentRunId)
    expect(children.every((child) => child.status === 'stopped')).toBe(true)
  })

  it('stops one sub-agent without touching its siblings', async () => {
    // Each child gets its own controller chained to the parent's rather than
    // sharing it, which is what makes this possible: one branch of an
    // investigation can be abandoned while the other two carry on.
    const stopped: string[] = []
    const { signals } = delegatingRun(() => {
      const first = runs.find((run) => run.parentRunId)
      if (!first) return
      stopped.push(first.id)
      agentRunService.stop(first.id)
    })
    await startAndSettle({ provider: 'anthropic', model: 'claude-sonnet-5' })

    expect(stopped).toHaveLength(1)
    expect(signals.get(stopped[0])!.aborted).toBe(true)
    const sibling = runs.find((run) => run.parentRunId && run.id !== stopped[0])!
    expect(signals.get(sibling.id)!.aborted).toBe(false)
    expect(sibling.status).toBe('done')
    // And the parent still finishes: one abandoned branch is a result to
    // work around, not a reason to lose the run.
    const parent = runs.find((run) => !run.parentRunId)!
    expect(parent.status).toBe('done')
  })

  it('stops every sub-agent on quit', async () => {
    // `stopAll` aborts the parent, which cascades, and then aborts every
    // child itself as well. This asserts the outcome rather than which of
    // the two paths delivered it — either alone would satisfy it, and the
    // point of the second is that quitting should not depend on the first.
    const { signals } = delegatingRun(() => agentRunService.stopAll())
    await startAndSettle({ provider: 'anthropic', model: 'claude-sonnet-5' })

    expect(signals.size).toBe(2)
    for (const signal of signals.values()) expect(signal.aborted).toBe(true)
  })
})

describe('on the local engine', () => {
  it('never offers delegation, because a local delegation deadlocks', () => {
    // `LlamaService.generate()` holds a single-slot model gate for the whole
    // turn. A parent blocked inside `delegate` holds that slot while waiting
    // for children who each need it, so neither can move. Measured: a parent
    // and its sub-agent sat at turn zero, zero tokens, for 33 minutes.
    subAgentsEnabled = true
    runGeneration.mockImplementation(async (request: any, io: any) => {
      noteTurn(request, io)
      return finished(io, 'Done', 100)
    })
    return startAndSettle({ provider: 'local' }).then(() => {
      expect(turns).toHaveLength(1)
      expect(turns[0].hasDelegate).toBe(false)
      expect(turns[0].enabledTools.has('delegate')).toBe(false)
    })
  })

  it('still offers it to a cloud run, where calls are genuinely concurrent', () => {
    subAgentsEnabled = true
    runGeneration.mockImplementation(async (request: any, io: any) => {
      noteTurn(request, io)
      return finished(io, 'Done', 100)
    })
    return startAndSettle({ provider: 'anthropic', model: 'claude-sonnet-5' }).then(() => {
      expect(turns[0].hasDelegate).toBe(true)
      expect(turns[0].enabledTools.has('delegate')).toBe(true)
    })
  })
})

describe('a delegating run that belongs to a series', () => {
  it('journals once, for the parent, and never for a sub-agent', () => {
    // The two features landed the same night and meet here. A sub-agent is a
    // step inside its parent's run, and the parent reports the same work in
    // full a moment later — journalling each child would fill a series'
    // history with fragments of something already recorded whole.
    subAgentsEnabled = true
    let delegated = false
    runGeneration.mockImplementation(async (request: any, io: any) => {
      const runId = noteTurn(request, io)
      const run = runs.find((entry) => entry.id === runId)
      if (run?.parentRunId) return finished(io, `Checked ${run.goal}`, 500)
      if (!delegated && io.delegate) {
        delegated = true
        await io.delegate(['check auth', 'check parsing'])
        return { content: 'delegated', stats: { tokens: 100 }, stopped: false }
      }
      return finished(io, 'Collated.', 100)
    })

    return startAndSettle().then(() => {
      expect(runs.filter((run) => run.parentRunId)).toHaveLength(2)
      const journalled = appendRunToJournal.mock.calls.map(([run]) => run)
      expect(journalled).toHaveLength(1)
      expect(journalled[0].parentRunId).toBeUndefined()
    })
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
