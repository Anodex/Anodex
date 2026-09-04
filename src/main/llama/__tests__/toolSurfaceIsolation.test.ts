import { describe, expect, it } from 'vitest'
import { buildTools } from '../../tools/registry'
import { rankToolNames } from '../toolSurface'
import type { ToolRuntimeContext } from '../../tools/types'
import type { ToolFunction } from '../../tools/types'

/**
 * Which tools each surface gets, and in what order — pinned, so that a change
 * aimed at one surface cannot quietly reorder another.
 *
 * Anodex's surfaces share one tool registry and one ranking list. That sharing
 * is deliberate and worth keeping, but it means `DIRECT_TOOL_PRIORITY` is a
 * global ordering applied to a per-surface candidate set, and on a small window
 * only about ten of those keep a native schema. So inserting one entry for
 * chat's benefit pushes an agent tool over the ceiling, silently, with no test
 * failing and no error anywhere. That has happened: a build-run ordering left
 * every chat and email tool sorting to infinity, and `anodex_status` was
 * deferred out from under a model that then answered "I don't have access to
 * your schedule" while holding it.
 *
 * The protection is not a rule anyone has to remember. It is that these
 * expectations are written out per surface, so editing the shared list fails
 * the test for exactly the surfaces it moves and prints the diff. A change that
 * touches only chat shows only chat's list changing; if agent's list moves too,
 * that was not the change anyone intended.
 *
 * The candidate sets come from `buildTools`, the real registry function, rather
 * than a list copied into this file. A copied list would agree with itself
 * forever while production drifted away from it.
 */

/** A `define` that registers nothing: this suite ranks names, never runs tools. */
const noopDefine = ((): unknown => ({})) as never

/**
 * A context with every gate open except the ones a surface is defined by.
 *
 * Cast once, here, and nowhere else. `ToolRuntimeContext` carries a dozen
 * fields that only matter once a tool actually runs (permission gates, plan
 * holders, per-turn flags); spelling them all out in each case would bury the
 * two or three fields that actually distinguish the surfaces.
 */
function contextFor(overrides: Partial<ToolRuntimeContext>): ToolRuntimeContext {
  return {
    conversationId: 'c1',
    messageId: 'm1',
    projectId: null,
    workspaceRoot: null,
    userFiles: [],
    permissionMode: 'ask',
    webSearch: { provider: 'searxng' },
    email: { accounts: [] },
    memory: { crossChatEnabled: true, personalEnabled: true, confirmBeforeSaving: false },
    enabledTools: null,
    disabledTools: new Set<string>(),
    plan: { current: null },
    turnGate: { approved: false },
    mcpTools: [],
    ...overrides
  } as unknown as ToolRuntimeContext
}

/** The surfaces, defined by exactly the context fields that distinguish them. */
const SURFACES = {
  /** Plain chat: no workspace, no project, one linked mail account. */
  chat: contextFor({ email: { accounts: [{ id: 'a1' }] } as never }),
  /** Chat with a folder open but no project: may read code, never change it. */
  workspaceReadOnly: contextFor({ workspaceRoot: '/repo' }),
  /** A project run, which is what the agent and the workspace both use. */
  project: contextFor({ workspaceRoot: '/repo', projectId: 'p1' })
} as const

function rankedFor(ctx: ToolRuntimeContext): string[] {
  return rankToolNames(buildTools(noopDefine, ctx))
}

describe('tool surface isolation', () => {
  /**
   * The property that makes the shared list safe to edit at all.
   *
   * Ranking is applied to a surface's own candidate set, so a tool absent from
   * that set cannot affect it. This is what lets someone add an entry for chat
   * and reason about the blast radius instead of guessing — but only while it
   * stays true, which is what this asserts.
   */
  it('a surface is unaffected by tools it does not have', () => {
    const project = rankedFor(SURFACES.project)
    const chat = rankedFor(SURFACES.chat)

    // Rank the union of every surface's tools, then check each surface's own
    // ranking is exactly that global order with the other surfaces' tools
    // removed. This is the isolation property stated directly: adding a tool
    // some surface does not have cannot change where its own tools sit.
    //
    // The obvious version of this assertion — filtering a surface's list by
    // itself — is a tautology that passes no matter what ranking does. The
    // comparison has to be against an ordering built from a *larger* set.
    const everything: Record<string, ToolFunction> = {
      ...buildTools(noopDefine, SURFACES.project),
      ...buildTools(noopDefine, SURFACES.chat)
    }
    const globalOrder = rankToolNames(everything)
    expect(globalOrder.length).toBeGreaterThan(project.length)

    for (const surface of [project, chat]) {
      const own = new Set(surface)
      expect(globalOrder.filter((name) => own.has(name))).toEqual(surface)
    }

    // Chat genuinely lacks the builder loop, and the project surface genuinely
    // lacks nothing chat has that matters — stated so the sets cannot silently
    // converge and make the isolation claim vacuous.
    expect(chat).not.toContain('write_file')
    expect(chat).not.toContain('run_command')
    expect(project).toContain('write_file')
  })

  /**
   * The ordering itself, per surface.
   *
   * These lists are meant to be edited when a change genuinely intends to move
   * a tool. What they prevent is moving one *without noticing* — the failure
   * mode where a chat fix costs the agent a tool at 8K and nobody finds out
   * until a model stops being able to edit files.
   */
  it('pins the ranked order chat gets', () => {
    expect(rankedFor(SURFACES.chat)).toMatchSnapshot()
  })

  it('pins the ranked order a project run gets', () => {
    expect(rankedFor(SURFACES.project)).toMatchSnapshot()
  })

  it('pins the ranked order a read-only workspace chat gets', () => {
    expect(rankedFor(SURFACES.workspaceReadOnly)).toMatchSnapshot()
  })

  /**
   * `schedule_task` is unranked, and therefore deferred at every context size.
   *
   * Anything absent from `DIRECT_TOOL_PRIORITY` sorts to infinity - the exact
   * shape of two bugs already fixed in `toolSurface.ts` (`anodex_status`,
   * `read_multiple_files`), each of which was deferred on every machine until
   * someone noticed. `schedule_task` is in that position now, while the chat
   * prompt calls it the one thing chat can actually change.
   *
   * This is asserted rather than fixed because the gateway does work: the
   * Scheduler suite creates and fires tasks with it deferred. Ranking it is a
   * cost/reliability judgement that wants its own measurement, not a change
   * smuggled in on the strength of looking wrong. The test exists so that
   * ranking it later is a deliberate act that updates this expectation, and so
   * the state is written down instead of rediscovered.
   */
  it('records that schedule_task is unranked, below every ranked chat tool', () => {
    const chat = rankedFor(SURFACES.chat)
    // `remember_fact` is the last chat tool carrying an explicit rank.
    expect(chat.indexOf('schedule_task')).toBeGreaterThan(chat.indexOf('remember_fact'))
  })
})
