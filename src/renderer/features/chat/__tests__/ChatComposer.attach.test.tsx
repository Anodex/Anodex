// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultSettings } from '@shared/settings.defaults'
import { fireEvent, render, screen, waitFor } from '../../../test-utils/dom'

/**
 * Closes the other gap round two shipped with.
 *
 * §11 found two attachment passes racing each other and fixed it by lifting the
 * intake into `intakeAttachments`, which is unit-tested. What could not be
 * tested then was the wiring *into* it — drop and picker both call it, and that
 * is where the second pass comes from. Renderer tests had no DOM, so a drop
 * event could not be dispatched at all.
 */

const readFile = vi.fn<(path: string) => Promise<unknown>>()
const pickFiles = vi.fn<() => Promise<{ path: string; name: string }[]>>()
const getPathForFile = vi.fn<(file: File) => string>()
const notifyError = vi.fn()
const sendMessage = vi.fn()
const clearReplaySuggestion = vi.fn()
const setConversationGoal = vi.fn()
const clearConversationGoal = vi.fn()
const stopGeneration = vi.fn()
let activeConversation: Record<string, unknown>

const settings = createDefaultSettings('/models')

vi.mock('../../../lib/anodex', () => ({
  anodex: {
    skills: { list: () => Promise.resolve([]) },
    attachments: {
      readFile: (path: string) => readFile(path),
      pickFiles: () => pickFiles()
    },
    workspace: { getAbsolutePath: (path: string) => Promise.resolve({ ok: true, value: path }) },
    system: { getPathForFile: (file: File) => getPathForFile(file) }
  }
}))

vi.mock('../../../stores/uiStore', () => ({ notifyError }))

vi.mock('../../../stores/chatStore', () => ({
  useChatStore: (select: (state: unknown) => unknown) =>
    select({
      conversations: [activeConversation],
      activeId: 'c1',
      pendingMessages: {},
      sendMessage,
      queueMessage: vi.fn(),
      removeQueuedMessage: vi.fn(),
      stopGeneration,
      pendingComposerText: null,
      setPendingComposerText: vi.fn(),
      clearReplaySuggestion,
      setConversationGoal,
      clearConversationGoal,
      compactConversation: vi.fn()
    })
}))

vi.mock('../../../stores/modelStore', () => ({
  useModelStore: (select: (state: unknown) => unknown) =>
    select({ engine: { status: 'ready', generating: false, vision: false } })
}))

vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: (select: (state: unknown) => unknown) => select({ settings, update: vi.fn() })
}))

vi.mock('../../../stores/projectStore', () => ({
  useProjectStore: (select: (state: unknown) => unknown) => select({ projects: [] })
}))

// Both pull in stores of their own and neither is what these tests are about.
vi.mock('../ContextMeter', () => ({ ContextMeter: () => null }))
vi.mock('../ToolConfirmCard', () => ({ ToolConfirmCard: () => null }))

const { ChatComposer } = await import('../ChatComposer')

function textFile(sizeBytes = 12): { ok: true; value: unknown } {
  return { ok: true, value: { kind: 'text', content: 'x', sizeBytes, truncated: false } }
}

/** Dispatch an OS file drop onto the composer. */
function dropFile(name: string): void {
  const composer = document.querySelector('[data-composer-input]')?.closest('div')?.parentElement
  const target = composer ?? document.body
  fireEvent.drop(target, {
    dataTransfer: {
      getData: () => '',
      files: [new File(['bytes'], name)]
    }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  activeConversation = { id: 'c1', messages: [], projectId: null }
  getPathForFile.mockImplementation((file: File) => `/dropped/${file.name}`)
  readFile.mockResolvedValue(textFile())
})

describe('dropping files onto the composer', () => {
  it('attaches a dropped file', async () => {
    render(<ChatComposer />)

    dropFile('notes.txt')

    await waitFor(() => expect(screen.getByText('notes.txt')).toBeDefined())
    expect(readFile).toHaveBeenCalledWith('/dropped/notes.txt')
  })

  /**
   * The regression §11 fixed, exercised end to end for the first time. Each
   * drop starts its own pass, and a pass awaits an IPC read per file — so
   * dropping the same file again before the first finished used to produce two
   * chips sharing one `path`, which is both this list's React key and the only
   * thing its remove button filters on.
   */
  it('does not attach the same file twice when a second drop lands mid-read', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    readFile.mockImplementation(async () => {
      await gate
      return textFile()
    })

    render(<ChatComposer />)
    dropFile('notes.txt')
    dropFile('notes.txt')
    release()

    await waitFor(() => expect(screen.getAllByText('notes.txt')).toHaveLength(1))
  })

  it('removes an attachment when its remove button is pressed', async () => {
    render(<ChatComposer />)
    dropFile('notes.txt')
    await waitFor(() => expect(screen.getByText('notes.txt')).toBeDefined())

    fireEvent.click(screen.getByLabelText('Remove notes.txt'))

    await waitFor(() => expect(screen.queryByText('notes.txt')).toBeNull())
  })

  it('reports a file it could not read, and attaches nothing', async () => {
    readFile.mockResolvedValue({
      ok: false,
      error: { code: 'attachments.read-failed', message: 'Permission denied' }
    })
    render(<ChatComposer />)

    dropFile('locked.txt')

    await waitFor(() =>
      expect(notifyError).toHaveBeenCalledWith('Could not attach file', 'Permission denied')
    )
    expect(screen.queryByText('locked.txt')).toBeNull()
  })
})

describe('composer chrome', () => {
  it('does not render the retired instruction line below the composer', () => {
    render(<ChatComposer />)

    expect(document.body.textContent).not.toContain('Enter to send')
    expect(document.body.textContent).not.toContain('Enter to queue for after this reply')
  })

  it('dismisses the slash picker when the user clicks away without clearing the draft', async () => {
    render(<ChatComposer />)

    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '/' } })
    await waitFor(() => expect(screen.getByRole('listbox')).toBeDefined())

    fireEvent.mouseDown(document.body)

    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
    expect(input).toHaveProperty('value', '/')
  })

  it('stores a /goal outcome and keeps it visible above the composer', () => {
    activeConversation = {
      id: 'c1',
      messages: [],
      projectId: null,
      goal: { title: 'Make recommendations fit this computer', createdAt: 1 },
      plan: {
        title: 'Recommendation work',
        updatedAt: 1,
        steps: [
          { id: 'one', title: 'Inspect hardware', status: 'completed' },
          { id: 'two', title: 'Rank models', status: 'in_progress' }
        ]
      }
    }
    render(<ChatComposer />)

    expect(screen.getByText('Make recommendations fit this computer')).toBeDefined()
    expect(screen.getByText('1/2 steps')).toBeDefined()

    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '/goal Keep this chat focused' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(setConversationGoal).toHaveBeenCalledWith('Keep this chat focused')
    expect(sendMessage).toHaveBeenCalledWith(
      'Set a focused goal for this task, create or update a concise visible plan, then begin the first unfinished step.\n\nAdditional context from the user:\nKeep this chat focused',
      []
    )
  })

  it('uses the composer stop button to clear an active goal', () => {
    activeConversation = {
      id: 'c1',
      messages: [{ id: 'm1', streaming: true }],
      projectId: null,
      goal: { title: 'Finish the migration', createdAt: 1 }
    }
    render(<ChatComposer />)

    fireEvent.click(screen.getByLabelText('Stop generating'))

    expect(clearConversationGoal).toHaveBeenCalledTimes(1)
    expect(stopGeneration).toHaveBeenCalledTimes(1)
  })
})

describe('composer replay suggestions', () => {
  it('shows the first unfinished plan step and accepts it with Tab without sending', () => {
    activeConversation = {
      id: 'c1',
      messages: [],
      projectId: null,
      plan: {
        title: 'Build replay suggestions',
        updatedAt: 1,
        steps: [
          { id: 'one', title: 'Phase 1: Foundations', status: 'completed' },
          { id: 'two', title: 'Phase 2: Composer replay', status: 'pending' }
        ]
      }
    }
    render(<ChatComposer />)

    expect(screen.getByText('Start working on Phase 2: Composer replay.')).toBeDefined()
    const input = screen.getByRole('textbox')
    fireEvent.keyDown(input, { key: 'Tab' })

    expect((input as HTMLTextAreaElement).value).toBe('Start working on Phase 2: Composer replay.')
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('lets Escape dismiss a suggestion without clearing the composer', () => {
    activeConversation = {
      id: 'c1',
      messages: [],
      projectId: null,
      replaySuggestion: {
        messageId: 'm1',
        text: 'Review the changed files and run focused tests.',
        createdAt: 1
      }
    }
    render(<ChatComposer />)

    const input = screen.getByRole('textbox')
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(screen.queryByText('Review the changed files and run focused tests.')).toBeNull()
    expect((input as HTMLTextAreaElement).value).toBe('')
  })

  it('invalidates generated copy when the user starts typing', () => {
    activeConversation = {
      id: 'c1',
      messages: [],
      projectId: null,
      replaySuggestion: {
        messageId: 'm1',
        text: 'Review the changed files and run focused tests.',
        createdAt: 1
      }
    }
    render(<ChatComposer />)

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Actually, focus on tests.' }
    })

    expect(clearReplaySuggestion).toHaveBeenCalledWith('c1')
    expect(screen.queryByText('Review the changed files and run focused tests.')).toBeNull()
  })
})
