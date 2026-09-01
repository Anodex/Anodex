import { llamaService } from '../llama/LlamaService'
import { settingsStore } from '../settings/SettingsStore'
import { criticalThinkingService } from './CriticalThinkingService'
import { criticalThinkingStore } from './CriticalThinkingStore'
import { createLogger } from '../utils/logger'

const log = createLogger('critical-thinking:autorun')

/**
 * Development-only harness: start a Critical Thinking run from the environment
 * and approve its plan unattended, so a run can be measured without driving the
 * GUI.
 *
 * Reproducing a run took a human clicking through plan review every time, which
 * made the one thing this work needs -- repeated fresh runs on the same
 * question -- the most expensive step in the loop. Nothing here changes how a
 * run behaves: it calls exactly the two methods the IPC handlers call, with the
 * plan the model itself produced.
 *
 * Inert unless `ANODEX_CT_AUTORUN` holds a question, and refuses to arm in a
 * packaged build.
 */
export function initCriticalThinkingAutorun(): void {
  const question = process.env.ANODEX_CT_AUTORUN?.trim()
  if (!question) return
  if (process.env.NODE_ENV === 'production') {
    log.warn('Autorun ignored in a packaged build.')
    return
  }
  log.info('Autorun armed:', question)
  void driveRun(question)
}

const POLL_MS = 2000
/** The renderer restores the last model a few seconds after paint; a local
 *  model then takes minutes to become ready. */
const MODEL_READY_TIMEOUT_MS = 15 * 60 * 1000
/** Planning is one short generation, but a cold model makes the first one slow. */
const PLAN_TIMEOUT_MS = 20 * 60 * 1000

async function driveRun(question: string): Promise<void> {
  try {
    // Only a local run has a model to wait for. A cloud run has no local part,
    // so gating it on the engine made it sit here for fifteen minutes and then
    // fail with a local diagnosis for a problem it could not have. Same defect
    // the agent autorun had.
    if (settingsStore.get().provider.active === 'local') {
      await waitFor(
        () => llamaService.getState().status === 'ready',
        MODEL_READY_TIMEOUT_MS,
        'model to become ready'
      )
    }
    const run = criticalThinkingService.start({ question })
    log.info('Autorun started run', run.id)
    await waitFor(
      () => criticalThinkingStore.get(run.id)?.status === 'needs-review',
      PLAN_TIMEOUT_MS,
      'a plan to review'
    )
    const planned = criticalThinkingStore.get(run.id)
    if (!planned?.plan) throw new Error('Plan review reached with no plan.')
    criticalThinkingService.approve(run.id, { plan: planned.plan })
    log.info('Autorun approved the plan for run', run.id)
  } catch (error) {
    log.error('Autorun failed:', error)
  }
}

async function waitFor(done: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`)
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}
