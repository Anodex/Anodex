// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultSettings } from '@shared/settings.defaults'
import { fireEvent, render, screen, waitFor } from '../../../test-utils/dom'
import type { AgentRunEditorSeed } from '../AgentRunEditor'

/**
 * First coverage for the form that decides what an unattended run is allowed to
 * do and how long it may do it for. Everything here is state across a re-render
 * or an async result, so it needs a real document.
 */

const create = vi.fn<(request: unknown) => Promise<unknown>>()
const onClose = vi.fn()

const settings = createDefaultSettings('/models')

vi.mock('../../../stores/agentStore', () => ({
  useAgentStore: (select: (state: unknown) => unknown) => select({ create })
}))
vi.mock('../../../stores/projectStore', () => ({
  useProjectStore: Object.assign(
    (select: (state: unknown) => unknown) => select({ projects: [{ id: 'p1', name: 'Anodex' }] }),
    { getState: () => ({ load: vi.fn() }) }
  )
}))
vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: (select: (state: unknown) => unknown) => select({ settings })
}))
vi.mock('../../../stores/uiStore', () => ({ notifyError: vi.fn() }))
vi.mock('../../../lib/anodex', () => ({
  anodex: { tools: { pickFolder: vi.fn() }, projects: { create: vi.fn() } }
}))

const { AgentRunEditor } = await import('../AgentRunEditor')

function open(seed?: AgentRunEditorSeed): void {
  render(<AgentRunEditor seed={seed} onClose={onClose} />)
}

function goalField(): HTMLTextAreaElement {
  return screen.getByPlaceholderText(/Research what CONTRIBUTING/)
}

beforeEach(() => {
  vi.clearAllMocks()
  settings.provider.anthropic.apiKey = ''
  settings.provider.openai.apiKey = ''
  settings.provider.active = 'local'
  create.mockResolvedValue({ id: 'run-1' })
})

describe('starting a run', () => {
  it('sends the configured goal and budgets', async () => {
    open()
    fireEvent.change(goalField(), { target: { value: 'Summarize the changelog' } })

    fireEvent.click(screen.getByText('Start run'))

    await waitFor(() => expect(create).toHaveBeenCalled())
    expect(create.mock.calls[0][0]).toMatchObject({
      goal: 'Summarize the changelog',
      provider: 'local',
      limitsEnabled: true,
      requirePlan: true
    })
    expect(onClose).toHaveBeenCalled()
  })

  /**
   * `agentStore.create` reports its own failure and returns null, and this used
   * to close regardless — so a refusal took the goal, the budgets and every
   * tool selection with it. The likeliest refusal is "Another agent run is
   * currently in progress", which is a matter of waiting a moment.
   */
  it('keeps the form open, and filled in, when the run is refused', async () => {
    create.mockResolvedValue(null)
    open()
    fireEvent.change(goalField(), { target: { value: 'Summarize the changelog' } })

    fireEvent.click(screen.getByText('Start run'))

    await waitFor(() => expect(create).toHaveBeenCalled())
    expect(onClose).not.toHaveBeenCalled()
    expect(goalField().value).toBe('Summarize the changelog')
  })

  it('will not start without a goal', () => {
    open()

    expect(screen.getByText('Start run').closest('button')).toHaveProperty('disabled', true)
  })
})

describe('choosing a provider', () => {
  it('offers only the providers this install has a key for', () => {
    settings.provider.anthropic.apiKey = 'sk-ant-test'
    open()

    expect(screen.getByText('Local model')).toBeDefined()
    expect(screen.getByText('Claude (Anthropic)')).toBeDefined()
    // No OpenAI key, so it is not offered — picking it could only fail.
    expect(screen.queryByText('ChatGPT / Codex (OpenAI)')).toBeNull()
  })

  /**
   * A retry seed carries the provider of a run created long ago, and the key
   * behind it may be gone — which left the select showing a value absent from
   * its own options and created a run that failed on its first turn.
   */
  it('falls back when a seeded provider has no key any more', async () => {
    open({ goal: 'Retry me', provider: 'anthropic', model: 'claude-x' })

    fireEvent.click(screen.getByText('Start run'))

    await waitFor(() => expect(create).toHaveBeenCalled())
    expect(create.mock.calls[0][0]).toMatchObject({ provider: 'local', model: null })
  })

  it('keeps a seeded provider that is still usable', async () => {
    settings.provider.anthropic.apiKey = 'sk-ant-test'
    open({ goal: 'Retry me', provider: 'anthropic', model: 'claude-x' })

    fireEvent.click(screen.getByText('Start run'))

    await waitFor(() => expect(create).toHaveBeenCalled())
    expect(create.mock.calls[0][0]).toMatchObject({ provider: 'anthropic', model: 'claude-x' })
  })
})

describe('tool access', () => {
  it('drops project-only tools when no project is selected', async () => {
    open({ goal: 'Do a thing', enabledTools: ['write_file', 'web_search'] })

    fireEvent.click(screen.getByText('Start run'))

    await waitFor(() => expect(create).toHaveBeenCalled())
    const request = create.mock.calls[0][0] as { enabledTools: string[] }
    expect(request.enabledTools).toContain('web_search')
    // `write_file` needs a project; a run started without one could never use it.
    expect(request.enabledTools).not.toContain('write_file')
  })

  it('says the time budget measures work, not waiting', () => {
    open()

    expect(document.body.textContent).toContain('time spent working')
    // Round four §2 moved this budget off wall-clock; the hint said otherwise.
    expect(document.body.textContent).not.toContain('wall-clock')
  })
})

/**
 * The editor is the one surface the measurement harness never touches — every
 * run in testing is started by `agentAutorun`, which bypasses this form
 * entirely. That is how "clicked Start and nothing happened, with no error
 * anywhere" survived: the path with the bug was the path nothing exercised.
 */
describe('why Start is unavailable', () => {
  it('says what is missing instead of only disabling the button', () => {
    open()

    expect(screen.getByText('Start run').closest('button')).toHaveProperty('disabled', true)
    expect(screen.getByText(/needs a goal/i)).toBeTruthy()
  })

  it('stops saying it once the goal is there', () => {
    open()
    fireEvent.change(goalField(), { target: { value: 'Summarize the changelog' } })

    expect(screen.getByText('Start run').closest('button')).toHaveProperty('disabled', false)
    expect(screen.queryByText(/needs a goal/i)).toBeNull()
  })

  it('treats a whitespace-only goal as missing', () => {
    open()
    fireEvent.change(goalField(), { target: { value: '   \n  ' } })

    expect(screen.getByText('Start run').closest('button')).toHaveProperty('disabled', true)
    expect(screen.getByText(/needs a goal/i)).toBeTruthy()
  })

  // The budgets are sliders with a minimum of 1 and a clamped seed, so they
  // cannot reach a blocking value from this form at all. The checks on them in
  // `startBlockedReason` are defence for programmatic callers, not a path a
  // user can take — recorded here so nobody re-derives it from the code.
  it('never blocks on a budget, because the sliders cannot leave range', () => {
    open()
    fireEvent.change(goalField(), { target: { value: 'Summarize the changelog' } })

    for (const slider of screen.getAllByRole('slider')) {
      expect(Number((slider as HTMLInputElement).value)).toBeGreaterThanOrEqual(1)
    }
    expect(screen.getByText('Start run').closest('button')).toHaveProperty('disabled', false)
  })
})
