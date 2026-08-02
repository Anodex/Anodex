/**
 * Registration for the dev-only walkthrough drivers used to record demo video.
 *
 * Each script drives the real UI through real DOM events, so what a recording
 * shows is the app behaving normally — nothing here is a mock, and no component
 * carries a demo affordance. Attached to `window` in dev builds only, so the
 * shipped app has no surface for any of it.
 *
 * Shortcuts (the app window is frameless, so the default Electron devtools
 * accelerator can't be relied on to open a console):
 *
 *   Ctrl+Shift+1   Scheduler — five tasks
 *   Ctrl+Shift+2   Agent — two unattended runs (read-only tools)
 *   Ctrl+Shift+3   Projects — scoped chat, file tree, live plan
 *   Ctrl+Shift+4   Chat — two turns
 *   Ctrl+Shift+5   Settings tour (B-roll)
 *   Ctrl+Shift+X   stop the current take
 *
 * From a console, `__anodexDemo.scheduler(2)` re-shoots a single step of the
 * scripts that take an index.
 */
import { hideCursor, showCursor } from './demoCursor'
import { Aborted, abort, resetAbort } from './demoKit'
import { runAgentDemo } from './agentDemo'
import { runChatDemo } from './chatDemo'
import { runProjectDemo } from './projectDemo'
import { runSchedulerDemo } from './schedulerDemo'
import { runSettingsTour } from './settingsTour'

/** Guards against a second take starting on top of one already playing. */
let running = false

/**
 * Wraps a script with the cursor lifecycle and abort handling, so each one is
 * written as plain steps and none of them repeat this.
 */
async function play(name: string, script: () => Promise<void>): Promise<void> {
  if (running) {
    console.warn('Demo: a take is already running — press Ctrl+Shift+X to stop it first')
    return
  }
  running = true
  resetAbort()
  showCursor()
  try {
    await script()
    console.log(`%c✔ ${name} demo finished`, 'color:green;font-weight:bold')
  } catch (error) {
    if (error instanceof Aborted) {
      console.log('Demo stopped')
      return
    }
    throw error
  } finally {
    running = false
    // The pointer lingers after the last step, so the final frame isn't the
    // cursor vanishing mid-shot.
    setTimeout(hideCursor, 1200)
  }
}

const demos = {
  scheduler: (only?: number) => play('Scheduler', () => runSchedulerDemo(only)),
  agent: (only?: number) => play('Agent', () => runAgentDemo(only)),
  projects: () => play('Projects', runProjectDemo),
  chat: () => play('Chat', runChatDemo),
  settings: () => play('Settings tour', runSettingsTour),
  stop: abort
}

/** Ctrl+Shift+<key> → script. */
const SHORTCUTS: Record<string, () => void> = {
  '1': () => void demos.scheduler(),
  '2': () => void demos.agent(),
  '3': () => void demos.projects(),
  '4': () => void demos.chat(),
  '5': () => void demos.settings(),
  x: () => demos.stop()
}

/**
 * Attaches the drivers in dev builds. Called from the renderer entry point;
 * a no-op in production.
 */
export function installDemos(): void {
  if (!import.meta.env.DEV) return
  Object.assign(window, { __anodexDemo: demos })

  window.addEventListener('keydown', (event) => {
    if (!event.ctrlKey || !event.shiftKey) return
    const handler = SHORTCUTS[event.key.toLowerCase()]
    if (!handler) return
    event.preventDefault()
    handler()
  })

  console.log(
    '%cDemos ready — Ctrl+Shift+1 Scheduler · 2 Agent · 3 Projects · 4 Chat · 5 Settings · X stop',
    'color:#888'
  )
}
