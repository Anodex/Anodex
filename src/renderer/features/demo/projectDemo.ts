/**
 * Projects walkthrough: what a project *gives* you — a scoped chat, the file
 * tree, and a plan the model builds and works through.
 *
 * Creating a project is deliberately not scripted. It opens the OS folder
 * picker (`anodex.tools.pickFolder`), which is a native dialog outside the
 * page — no DOM driver can drive it, and a half-driven take would stall on a
 * modal the pointer can't reach. Create the project by hand before recording;
 * this script picks up from there.
 *
 * The plan segment is the one part that depends on the model: plans appear
 * because the model calls `write_plan`, not because the UI forces one. The
 * script sends a plan-shaped request and waits for steps to show up, then
 * carries on regardless — see `waitForPlan`.
 *
 * Dev-only; registered in `index.ts`.
 */
import { clickElement } from './demoCursor'
import { FIELD_PAUSE_MS, PREVIEW_PAUSE_MS, beat, type, waitFor } from './demoKit'

/** How long to give the model to produce a plan before moving on without one. */
const PLAN_TIMEOUT_MS = 90_000

/** Folders opened in the tree, to show it's a real filesystem view. */
const TREE_FOLDERS_TO_OPEN = 2

/**
 * The prompt that drives the segment. Plan-shaped on purpose — it asks for the
 * work to be laid out before any of it happens, which is what makes the model
 * reach for `write_plan` rather than just answering.
 */
const PLAN_PROMPT =
  'Plan out how you would add a dark mode toggle to this project. Lay out the steps first, before changing anything.'

/**
 * The dock's panel menu opens on hover, not click. A programmatic pointer
 * fires no real mouse events, so the enter has to be dispatched by hand —
 * `clickElement` only produces a click.
 */
function hover(el: Element): void {
  el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))
  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
}

/** The first project row in the sidebar's workspace section. */
function firstProjectToggle(): HTMLButtonElement | null {
  const sidebar = document.querySelector('aside')
  if (!sidebar) return null
  // Project rows are the buttons carrying the project name as their title,
  // which none of the nav or action buttons do.
  const reserved = ['New project', 'New chat', 'New chat in project', 'Collapse all projects']
  return (
    [...sidebar.querySelectorAll<HTMLButtonElement>('button[title]')].find(
      (el) => el.title.length > 0 && !reserved.includes(el.title)
    ) ?? null
  )
}

const composer = (): HTMLTextAreaElement | null =>
  document.querySelector<HTMLTextAreaElement>('textarea[data-composer-input]')

/** Expands the first project and starts a chat scoped to it. */
async function openProjectChat(): Promise<void> {
  console.log('%c▶ Opening a project and starting a chat inside it', 'font-weight:bold')

  const project = await waitFor(firstProjectToggle, 'a project row in the sidebar')
  await clickElement(project)
  await beat(PREVIEW_PAUSE_MS)

  // Hovering the row is what reveals its per-project actions.
  hover(project.parentElement ?? project)
  await beat(500)

  const newChatInProject = await waitFor(
    () => document.querySelector<HTMLButtonElement>('button[aria-label="New chat in project"]'),
    'the "New chat in project" button'
  )
  await clickElement(newChatInProject)
  await beat(2200)
}

/** Opens the dock if it's collapsed, and returns its button for menu hovers. */
async function ensureDockOpen(): Promise<HTMLButtonElement> {
  const dockButton = await waitFor(
    () =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Expand workspace dock"]') ??
      document.querySelector<HTMLButtonElement>('button[aria-label="Collapse workspace dock"]'),
    'the workspace dock button'
  )
  // Only expand if currently collapsed — clicking blind would close an
  // already-open dock and leave the rest of the tour with nothing on screen.
  if (dockButton.getAttribute('aria-label') === 'Expand workspace dock') {
    await clickElement(dockButton)
    await beat(PREVIEW_PAUSE_MS)
  }
  return dockButton
}

/** Switches the dock to a named panel. */
async function openDockPanel(dockButton: HTMLButtonElement, panelName: string): Promise<boolean> {
  const container = dockButton.parentElement
  if (container) hover(container)
  await beat(450)

  const entry = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]')].find(
    (el) => el.textContent?.trim().startsWith(panelName)
  )
  if (!entry) {
    console.warn(`Projects demo: dock panel "${panelName}" not available here, skipping`)
    return false
  }
  await clickElement(entry)
  await beat(PREVIEW_PAUSE_MS)
  return true
}

/**
 * Opens the Files panel and collapses/expands a couple of folders, so the tree
 * visibly responds instead of sitting there as a static screenshot.
 */
async function tourFileTree(dockButton: HTMLButtonElement): Promise<void> {
  console.log('%c▶ The file tree', 'font-weight:bold')

  if (!(await openDockPanel(dockButton, 'Files'))) return
  await beat(PREVIEW_PAUSE_MS)

  // Folder disclosure buttons are the only childless buttons in the tree rows;
  // taking them in document order walks down the tree the way a person would.
  const folders = [...document.querySelectorAll<HTMLButtonElement>('button')].filter((el) =>
    el.closest('[class*="fileTree"], [class*="FileTree"], [class*="filesPanel"]')
  )
  for (const folder of folders.slice(0, TREE_FOLDERS_TO_OPEN)) {
    await clickElement(folder)
    await beat(1100)
  }
}

/** Sends the plan-shaped prompt into the project's chat. */
async function sendPlanPrompt(): Promise<void> {
  console.log('%c▶ Asking for a plan', 'font-weight:bold')

  const input = await waitFor(composer, 'the chat composer')
  await type(input, PLAN_PROMPT)
  await beat(FIELD_PAUSE_MS)

  const send = await waitFor(
    () => document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]'),
    'the send button'
  )
  await clickElement(send)
}

/**
 * Waits for the Plan panel to show steps. Returns false on timeout rather than
 * throwing: the model may answer without planning, and losing the whole take to
 * that would be worse than continuing without the panel.
 */
async function waitForPlan(dockButton: HTMLButtonElement): Promise<boolean> {
  if (!(await openDockPanel(dockButton, 'Plan'))) return false

  const deadline = Date.now() + PLAN_TIMEOUT_MS
  while (Date.now() < deadline) {
    const panel = document.querySelector('[class*="planPanel"], [class*="PlanPanel"]')
    // An empty panel renders its own placeholder copy; real steps are list items.
    if (panel && panel.querySelectorAll('li').length > 0) return true
    await beat(1000)
  }
  console.warn(
    'Projects demo: no plan appeared within 90s — the model answered without calling write_plan. ' +
      'Re-shoot, or narrate over the reply instead.'
  )
  return false
}

/** The full projects segment: scoped chat, file tree, then a live plan. */
export async function runProjectDemo(): Promise<void> {
  await openProjectChat()
  await beat(FIELD_PAUSE_MS)

  const dockButton = await ensureDockOpen()
  await tourFileTree(dockButton)
  await beat(FIELD_PAUSE_MS)

  await sendPlanPrompt()
  const planned = await waitForPlan(dockButton)
  // Hold on the finished plan — the steps ticking over is the payoff shot.
  await beat(planned ? 6000 : 2000)
}
