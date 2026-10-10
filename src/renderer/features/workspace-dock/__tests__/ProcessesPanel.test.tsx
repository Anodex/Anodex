// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackgroundProcessInfo } from '@shared/process.types'
import { fireEvent, render, screen, waitFor } from '../../../test-utils/dom'

const list = vi.fn<(projectId: string | null) => Promise<BackgroundProcessInfo[]>>()
const stop = vi.fn<(id: string) => Promise<void>>()
const output = vi.fn<(id: string) => Promise<string>>()
let changed: ((info: BackgroundProcessInfo) => void) | null = null

vi.mock('../../../lib/anodex', () => ({
  anodex: {
    processes: {
      list,
      stop,
      output,
      onChanged: (listener: (info: BackgroundProcessInfo) => void) => {
        changed = listener
        return () => (changed = null)
      }
    }
  }
}))
vi.mock('../useWorkspaceDockAvailability', () => ({ useWorkspaceDockProjectId: () => 'p1' }))

const { ProcessesPanel } = await import('../panels/ProcessesPanel')

function server(overrides: Partial<BackgroundProcessInfo> = {}): BackgroundProcessInfo {
  return {
    id: 'abc12345',
    name: 'npm run dev',
    command: 'npm run dev',
    projectId: 'p1',
    conversationId: 'c1',
    cwd: '/work',
    startedAt: Date.now() - 29_000,
    status: 'running',
    exitCode: null,
    endedAt: null,
    url: 'http://localhost:5173/',
    ...overrides
  }
}

beforeEach(() => {
  list.mockReset()
  stop.mockReset().mockResolvedValue(undefined)
  output.mockReset().mockResolvedValue('VITE ready\nLocal: http://localhost:5173/')
})

describe('ProcessesPanel', () => {
  it('says what will appear here when nothing is running', async () => {
    list.mockResolvedValue([])
    render(<ProcessesPanel />)
    expect(await screen.findByText('Nothing running')).toBeTruthy()
  })

  it('shows a running server with its address, and stops it', async () => {
    list.mockResolvedValue([server()])
    render(<ProcessesPanel />)

    const link = await screen.findByRole('link', { name: /localhost:5173/ })
    expect(link.getAttribute('href')).toBe('http://localhost:5173/')
    fireEvent.click(screen.getByRole('button', { name: 'Stop npm run dev' }))
    expect(stop).toHaveBeenCalledWith('abc12345')
  })

  it('follows a process as it ends, and no longer offers to stop it', async () => {
    list.mockResolvedValue([server()])
    render(<ProcessesPanel />)
    await screen.findByRole('button', { name: 'Stop npm run dev' })

    changed?.(server({ status: 'exited', exitCode: 1, endedAt: Date.now(), url: null }))
    await waitFor(() => expect(screen.getByText('exited 1')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Stop npm run dev' })).toBeNull()
  })
})
