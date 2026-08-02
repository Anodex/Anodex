/**
 * Shared plumbing for the dev-only walkthrough drivers (Scheduler, Agent,
 * Projects, Chat, Settings). Everything here is view-agnostic: finding a node
 * that hasn't mounted yet, typing into a controlled React input the way a
 * keyboard would, and the abort control every driver checks between steps.
 *
 * The per-view scripts live next door and hold only what's specific to them.
 * Dev-only — see `installDemos`; none of this is reachable in a production build.
 */
import { clickElement, focusElement } from './demoCursor'

/** Per-character typing speed. Jittered so the cadence doesn't read as a macro. */
export const CHAR_MS = 55
export const CHAR_JITTER_MS = 35
/** Extra pause after punctuation, where a person visibly draws breath. */
export const PUNCTUATION_MS = 180
/** Beat between one field being filled and the next being focused. */
export const FIELD_PAUSE_MS = 700
/** Held after a value lands, so whatever it changed on screen is readable. */
export const PREVIEW_PAUSE_MS = 1400
/** Held between one unit of work finishing and the next starting. */
export const STEP_PAUSE_MS = 2600

/** Set by `abort()`; every await point checks it and bails. */
let aborted = false

export class Aborted extends Error {}

export function abort(): void {
  aborted = true
}

export function resetAbort(): void {
  aborted = false
}

/** Sleeps, then throws `Aborted` if the take was stopped while we waited. */
export async function beat(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
  if (aborted) throw new Aborted()
}

export function jitter(base: number, spread: number): number {
  return base + (Math.random() - 0.5) * spread
}

/**
 * Waits for a selector to resolve. Modals mount a frame after the click that
 * opens them, and lists re-render as stores settle, so every lookup polls
 * rather than assuming the node is already there.
 */
export async function waitFor<T extends Element>(
  find: () => T | null,
  what: string,
  timeoutMs = 4000
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = find()
    if (found) return found
    if (Date.now() > deadline) throw new Error(`Demo: timed out waiting for ${what}`)
    await beat(50)
  }
}

/**
 * Sets a controlled input's value the way a keystroke would. React installs its
 * own `value` setter on the element instance, so assigning `el.value` directly
 * is invisible to it — the native prototype setter has to be called first, then
 * the event dispatched, or the component's state never moves.
 */
export function setControlledValue(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string
): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement
        : HTMLInputElement
  // Pulling the setter off the prototype and re-binding it to the instance is
  // the whole point here, so `unbound-method` is describing the intent rather
  // than a mistake.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set
  setter?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Types `text` into `el` one character at a time, at a human-ish cadence. */
export async function type(
  el: HTMLInputElement | HTMLTextAreaElement,
  text: string
): Promise<void> {
  await focusElement(el)
  setControlledValue(el, '')
  await beat(120)
  for (const char of text) {
    setControlledValue(el, el.value + char)
    await beat(jitter(CHAR_MS, CHAR_JITTER_MS))
    if (',.:;?!'.includes(char)) await beat(PUNCTUATION_MS)
  }
}

/** Backspaces a field empty, for demos that type a value and then correct it. */
export async function clearByBackspace(el: HTMLInputElement): Promise<void> {
  el.focus()
  while (el.value.length > 0) {
    setControlledValue(el, el.value.slice(0, -1))
    await beat(jitter(28, 16))
  }
}

/** Picks a `<select>` option and fires the change React listens for. */
export function selectOption(select: HTMLSelectElement, value: string): void {
  setControlledValue(select, value)
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

/** First element matching `selector` whose trimmed text equals `text`. */
export function byText<T extends Element>(selector: string, text: string): T | null {
  const match = [...document.querySelectorAll(selector)].find(
    (el) => el.textContent?.trim().toLowerCase() === text.toLowerCase()
  )
  return (match as T) ?? null
}

/** Waits for a button with exactly this label, then clicks it with the cursor. */
export async function clickButton(text: string, timeoutMs = 4000): Promise<void> {
  const button = await waitFor(
    () => byText<HTMLButtonElement>('button', text),
    `the "${text}" button`,
    timeoutMs
  )
  await clickElement(button)
}

/**
 * Finds a tool checkbox by the `<code>` tool name rendered beside it. Matching
 * on the name rather than an index keeps the scripts valid as the tool catalog
 * grows or reorders.
 */
export function toolCheckbox(toolName: string): HTMLInputElement | null {
  const label = [...document.querySelectorAll('label')].find(
    (el) => el.querySelector('code')?.textContent?.trim() === toolName
  )
  return label?.querySelector('input[type="checkbox"]') ?? null
}

/** Ticks each named tool in turn, skipping any that isn't available here. */
export async function tickTools(toolNames: string[]): Promise<void> {
  for (const toolName of toolNames) {
    const checkbox = toolCheckbox(toolName)
    if (!checkbox || checkbox.disabled) {
      console.warn(`Demo: tool "${toolName}" not available here, skipping`)
      continue
    }
    if (!checkbox.checked) await clickElement(checkbox)
    await beat(420)
  }
}

/**
 * Picks the first real project in a "No project (plain chat)" dropdown. The
 * scripts run on whatever machine is recording, so hard-coding a project id
 * would break every take but the author's.
 */
export async function pickFirstProject(): Promise<void> {
  const select = await waitFor<HTMLSelectElement>(
    () =>
      [...document.querySelectorAll('select')].find((el) =>
        [...el.options].some((option) => option.text.startsWith('No project'))
      ) ?? null,
    'the project picker'
  )
  const firstProject = [...select.options].find((option) => option.value !== '')
  if (firstProject) selectOption(select, firstProject.value)
}

/** Glides to the sidebar's nav item for a view and clicks it. */
export async function gotoView(label: string): Promise<void> {
  const nav = await waitFor(
    () =>
      document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ??
      document.querySelector<HTMLButtonElement>(`button[aria-label^="${label}"]`),
    `the ${label} nav item`
  )
  await clickElement(nav)
  await beat(1600)
}

/** Clicks the sidebar's New chat button, which also returns to the chat view. */
export async function gotoNewChat(): Promise<void> {
  const newChat = await waitFor(
    () =>
      [...document.querySelectorAll<HTMLButtonElement>('button')].find(
        (el) => el.querySelector('span')?.textContent?.trim() === 'New chat'
      ) ?? null,
    'the "New chat" button'
  )
  await clickElement(newChat)
  await beat(1800)
}
