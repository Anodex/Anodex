import { describe, expect, it } from 'vitest'
import type { BackgroundProcessInfo } from '@shared/process.types'
import type { ReminderSenders } from '../../scheduler/reminderDelivery'
import { DoneNotices } from '../doneNotices'
import { noticeAfterReply, takeReplyNotice } from '../replyNotices'

function processInfo(overrides: Partial<BackgroundProcessInfo> = {}): BackgroundProcessInfo {
  return {
    id: 'proc-1',
    name: 'dev',
    command: 'npm run dev',
    projectId: null,
    conversationId: null,
    cwd: '/work',
    startedAt: 0,
    status: 'running',
    exitCode: null,
    endedAt: null,
    url: null,
    ...overrides
  }
}

function setup(initial: BackgroundProcessInfo | undefined) {
  const shown: Array<{ title: string; body: string }> = []
  const phoned: string[] = []
  const listeners = new Set<(info: BackgroundProcessInfo) => void>()
  const senders: ReminderSenders = {
    desktop: (title, body) => shown.push({ title, body }),
    phoneConnected: () => true,
    phone: (title) => phoned.push(title),
    email: () => Promise.resolve()
  }
  const notices = new DoneNotices(
    () => senders,
    () => ({
      get: () => initial,
      onChange: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    })
  )
  const emit = (info: BackgroundProcessInfo): void => {
    for (const listener of [...listeners]) listener(info)
  }
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
  return { notices, shown, phoned, listeners, emit, flush }
}

describe('DoneNotices.watchProcess', () => {
  it('tells the person once a dev server shows its address, then stops listening', async () => {
    const t = setup(processInfo())
    expect(
      t.notices.watchProcess('proc-1', 'ready', { message: 'The site', via: ['desktop'] })
    ).toBe('watching')
    t.emit(processInfo({ id: 'other', url: 'http://localhost:1' }))
    t.emit(processInfo())
    await t.flush()
    expect(t.shown).toHaveLength(0)

    t.emit(processInfo({ url: 'http://localhost:5173/' }))
    t.emit(processInfo({ url: 'http://localhost:5173/' }))
    await t.flush()
    expect(t.shown.map((toast) => toast.title)).toEqual([
      'The site: ready at http://localhost:5173/'
    ])
    expect(t.listeners.size).toBe(0)
  })

  it('waits past the address for "exits", and reports the exit code', async () => {
    const t = setup(processInfo())
    t.notices.watchProcess('proc-1', 'exits', { message: 'The build', via: ['phone'] })
    t.emit(processInfo({ url: 'http://localhost:5173/' }))
    await t.flush()
    expect(t.phoned).toHaveLength(0)

    t.emit(processInfo({ status: 'exited', exitCode: 1 }))
    await t.flush()
    expect(t.phoned).toEqual(['The build: finished (exit code 1)'])
  })

  it('sends at once when it has already ended, and knows an unknown id', async () => {
    const ended = setup(processInfo({ status: 'failed' }))
    expect(ended.notices.watchProcess('proc-1', 'exits', { message: 'It', via: ['desktop'] })).toBe(
      'now'
    )
    await ended.flush()
    expect(ended.shown.map((toast) => toast.title)).toEqual(['It: failed'])
    expect(ended.listeners.size).toBe(0)

    const missing = setup(undefined)
    expect(missing.notices.watchProcess('nope', 'exits', { message: 'It' })).toBe('unknown')
  })
})

describe('reply notices', () => {
  it('are taken once, and a later one for the same reply replaces the first', () => {
    noticeAfterReply('msg-1', { message: 'First' })
    noticeAfterReply('msg-1', { message: 'Second', via: ['email'] })
    expect(takeReplyNotice('msg-1')).toEqual({ message: 'Second', via: ['email'] })
    expect(takeReplyNotice('msg-1')).toBeUndefined()
  })
})
