import { describeRecurrence } from '@shared/parseWhen'
import {
  ANODEX_STATUS_SECTIONS,
  renderAnodexStatus,
  type AnodexStatusSection,
  type AnodexStatusSnapshot
} from '@shared/anodexStatus'
import type { ToolFactory } from './types'
import { runReadTool } from './helpers'
import { schedulerStore } from '../scheduler/SchedulerStore'
import { agentRunStore } from '../agents/AgentRunStore'
import { criticalThinkingStore } from '../criticalThinking/CriticalThinkingStore'
import { projectStore } from '../projects/ProjectStore'
import { settingsStore } from '../settings/SettingsStore'

/**
 * `anodex_status` — let a conversation answer questions about Anodex itself.
 *
 * Chat could describe what the Scheduler *is* and where to find it, but not
 * what was in it, so "what have I got scheduled?" produced a tour of a feature
 * rather than an answer, with the real list one page away. Anodex is a
 * local-first app sitting on all of this data; not being able to say what is in
 * it was a gap no cloud assistant even has the option of filling.
 *
 * ## Read-only by construction
 *
 * This tool reads stores and renders text. There is no write path in it or in
 * `renderAnodexStatus` to reach, so "it cannot change anything" is a property of
 * the wiring rather than an instruction a model might ignore — which matters,
 * because a 4B model ignoring an instruction is a measured event here, not a
 * hypothetical.
 *
 * ## One tool, not five
 *
 * A tool per area would read more naturally and cost far more: on an 8,192-token
 * window only ten tools stay directly callable (`maxDirectToolsForContext`) and
 * the rest fall behind the find/describe/call gateway. Five schemas to answer
 * "how are things?" would push genuinely useful tools out of reach, so one
 * schema with a `section` argument does the job at a fifth of the cost.
 *
 * Email reports linked accounts and never message content. Whether an account is
 * linked is configuration; what is in it is correspondence, and reading mail has
 * its own separately gated tools.
 */
export const anodexStatusTool: ToolFactory = (define, ctx) =>
  define({
    description:
      "Report Anodex's own current state: scheduled tasks, agent runs, Critical Thinking runs, projects, and linked email accounts. Use it when the user asks what is scheduled, what a run is doing, or what they have set up. Read-only — it reports state and cannot start, stop, or change anything. Omit `section` for a summary of everything.",
    params: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          enum: [...ANODEX_STATUS_SECTIONS],
          description:
            'Which area to report on. Omit or use "overview" for a one-line summary of each, then call again for the area the user cares about.'
        }
      }
    } as const,
    handler: (args: { section?: AnodexStatusSection }) =>
      runReadTool(ctx, {
        name: 'anodex_status',
        kind: 'read',
        title: `Anodex status: ${args.section ?? 'overview'}`,
        args,
        run() {
          // Validated rather than trusted: `section` arrives from the model, and
          // an unrecognised value should fall back to the overview rather than
          // render an empty section that reads as "you have nothing".
          const section: AnodexStatusSection = ANODEX_STATUS_SECTIONS.includes(
            args.section as AnodexStatusSection
          )
            ? (args.section as AnodexStatusSection)
            : 'overview'
          const text = renderAnodexStatus(gatherStatusSnapshot(), section)
          return Promise.resolve({
            modelResult: text,
            detail: section
          })
        }
      })
  })

/**
 * Read every store once into the plain shape `renderAnodexStatus` expects.
 *
 * Kept separate from the renderer so the formatting is testable without
 * Electron, and separate from the tool so a future surface (a status panel, a
 * scheduled digest) can reuse the gathering without going through a tool call.
 */
export function gatherStatusSnapshot(): AnodexStatusSnapshot {
  const projects = projectStore.getState()
  const settings = settingsStore.get()
  const projectNames = new Map(projects.projects.map((project) => [project.id, project.name]))

  return {
    now: Date.now(),
    scheduler: schedulerStore.list().map((task) => ({
      name: task.name,
      enabled: task.enabled,
      // The same phrasing the Scheduler's own When field produces, so the two
      // surfaces never describe one schedule two different ways.
      schedule: describeRecurrence(task.recurrence),
      nextRunAt: task.nextRunAt,
      lastRunAt: task.lastRunAt,
      lastRunStatus: task.lastRunStatus
    })),
    agents: agentRunStore.list().map((run) => ({
      goal: run.goal,
      status: run.status,
      turnsUsed: run.turnsUsed,
      maxTurns: run.maxTurns,
      updatedAt: run.updatedAt,
      projectName: run.projectId ? (projectNames.get(run.projectId) ?? null) : null
    })),
    criticalThinking: criticalThinkingStore.list().map((run) => ({
      question: run.question,
      status: run.status,
      sourceCount: run.sources.length,
      updatedAt: run.updatedAt
    })),
    projects: projects.projects.map((project) => ({
      name: project.name,
      isActive: project.id === projects.activeProjectId
    })),
    email: settings.email.accounts.map((account) => ({
      address: account.address,
      provider: account.provider
    }))
  }
}
