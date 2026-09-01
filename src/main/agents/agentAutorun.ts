import { existsSync, readFileSync } from 'node:fs'
import { buildRunToolNames } from '@shared/tools.types'
import type { AgentRunProviderId } from '@shared/agentRunProviders'
import { llamaService } from '../llama/LlamaService'
import { ensureLocalModelLoaded } from '../llama/ensureLocalModelLoaded'
import { describeModel } from '../llama/modelScanner'
import { resolveModelContextSize } from '@shared/modelContextSize'
import { settingsStore } from '../settings/SettingsStore'
import { projectStore } from '../projects/ProjectStore'
import { agentRunService } from './AgentRunService'
import { agentRunStore } from './AgentRunStore'
import { createLogger } from '../utils/logger'

const log = createLogger('agent:autorun')

/**
 * Development-only harness: start an agent run from the environment and approve
 * its plan unattended, so a Workspace run can be measured without driving the
 * GUI.
 *
 * The sibling of `criticalThinkingAutorun.ts`, built for the same reason and in
 * the same shape. Measuring Workspace needs repeated fresh runs, and every one
 * of them otherwise costs a human filling in the run editor and clicking
 * through plan review — which made the most-repeated step in the loop the most
 * expensive one, and produced at least one session where a run was believed to
 * have started and had not.
 *
 * Nothing here changes how a run behaves: it calls exactly the two methods the
 * IPC handlers call (`start`, then `approvePlan`), with the plan the model
 * itself produced. It cannot make a run pass — it only removes the clicking.
 *
 * Inert unless `ANODEX_AGENT_AUTORUN` points at a spec file, and refuses to arm
 * in a packaged build.
 */
export function initAgentAutorun(): void {
  const specPath = process.env.ANODEX_AGENT_AUTORUN?.trim()
  if (!specPath) return
  if (process.env.NODE_ENV === 'production') {
    log.warn('Autorun ignored in a packaged build.')
    return
  }
  void driveRun(specPath)
}

/**
 * What the spec file holds. Only `goal` is required; everything else falls back
 * to the same defaults the run editor seeds, so a spec stays readable.
 *
 * `project` is matched by name against the project list rather than given as an
 * id, because ids are generated and a spec file is written by hand.
 */
interface AutorunSpec {
  goal: string
  /** Project name, as shown in the sidebar. Omit for a general (no-workspace) run. */
  project?: string
  /**
   * Absolute workspace folder, used only when no project of that name exists
   * yet. Measuring a *new* project otherwise needs someone to create it in the
   * GUI, which is the step this harness exists to remove.
   */
  projectPath?: string
  enabledTools?: string[]
  provider?: AgentRunProviderId
  model?: string | null
  maxTurns?: number
  maxTokens?: number
  maxDurationMinutes?: number
  limitsEnabled?: boolean
  requirePlan?: boolean
}

const POLL_MS = 2000
/** The renderer restores the last model a few seconds after paint; a local
 *  model then takes minutes to become ready. */
const MODEL_READY_TIMEOUT_MS = 15 * 60 * 1000
/** Planning is one short generation, but a cold model makes the first one slow. */
const PLAN_TIMEOUT_MS = 20 * 60 * 1000

async function driveRun(specPath: string): Promise<void> {
  try {
    const spec = readSpec(specPath)
    const provider = spec.provider ?? 'local'
    log.info('Autorun armed:', provider, '-', spec.goal.slice(0, 120))

    // Only a local run has a model to wait for. Gating a cloud run on the local
    // engine made a DeepSeek autorun sit here for fifteen minutes and then fail
    // as 'model load or autorun failed' — a message describing a local problem
    // that a cloud run does not have.
    if (provider === 'local') {
      // Nothing in the main process asks for a model - the renderer restores the
      // last one after it paints - so waiting for `ready` could wait forever when
      // that did not happen. Measured: two of four runs in one sweep never
      // started, their logs showing no model-load line at all. Ask for it here
      // rather than hoping.
      const loaded = await ensureLocalModelLoaded({
        status: llamaService.getState().status,
        lastModelPath: settingsStore.get().lastModelPath,
        describeModel,
        loadModel: (options, info) => llamaService.loadModel(options, info),
        contextSize: resolveModelContextSize(
          settingsStore.get(),
          settingsStore.get().lastModelPath ?? null
        )
      })
      if (loaded === 'no-model-configured' || loaded === 'model-file-missing') {
        throw new Error(`Cannot start a local run: ${loaded.replace(/-/g, ' ')}.`)
      }
      log.info('Local model:', loaded)
      await waitFor(
        () => llamaService.getState().status === 'ready',
        MODEL_READY_TIMEOUT_MS,
        'model to become ready'
      )
    }

    const run = agentRunService.start({
      goal: spec.goal,
      projectId: resolveProjectId(spec.project, spec.projectPath),
      enabledTools: spec.enabledTools ?? buildRunToolNames(),
      provider,
      model: spec.model ?? null,
      maxTurns: spec.maxTurns,
      maxTokens: spec.maxTokens,
      maxDurationMinutes: spec.maxDurationMinutes,
      limitsEnabled: spec.limitsEnabled,
      requirePlan: spec.requirePlan
    })
    log.info('Autorun started run', run.id, 'conversation', run.conversationId)

    // A run created with `requirePlan: false` never enters review, and waiting
    // for a state it cannot reach would time out on a perfectly good run.
    if (run.requirePlan === false) return

    await waitFor(
      () => agentRunStore.get(run.id)?.status === 'needs-review',
      PLAN_TIMEOUT_MS,
      'a plan to review'
    )
    agentRunService.approvePlan(run.id)
    log.info('Autorun approved the plan for run', run.id)
  } catch (error) {
    log.error('Autorun failed:', error)
  }
}

function readSpec(specPath: string): AutorunSpec {
  const spec = JSON.parse(readFileSync(specPath, 'utf-8')) as AutorunSpec
  if (!spec?.goal?.trim()) throw new Error(`${specPath} has no goal.`)
  return spec
}

/**
 * Fail loudly on an unknown project name. Falling back to a general run would
 * start something that looks right in the log and has no workspace — the
 * failure this harness exists to stop being mistaken for a Workspace result.
 */
function resolveProjectId(name: string | undefined, folderPath?: string): string | null {
  if (!name) return null
  const match = projectStore.getState().projects.find((project) => project.name === name)
  if (match) return match.id

  if (folderPath) {
    // Only ever reached for a spec that named the folder explicitly. The
    // directory has to exist already: creating one here would happily point a
    // run at an empty path produced by a typo, and a run with nothing to work
    // on is exactly the false result this harness is meant to prevent.
    if (!existsSync(folderPath)) {
      throw new Error(`projectPath "${folderPath}" does not exist.`)
    }
    const created = projectStore.create({ name, folderPath })
    log.info('Autorun created project', created.id, name, folderPath)
    return created.id
  }

  const known = projectStore
    .getState()
    .projects.map((project) => project.name)
    .join(', ')
  throw new Error(
    `No project named "${name}", and no projectPath was given. Known projects: ${known}`
  )
}

async function waitFor(done: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`)
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}
