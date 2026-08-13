import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatImageInput } from '@shared/chat.types'
import type { ValidatedComputerAction } from '@shared/computerControl.types'
import {
  COMPUTER_CONTROL_REPEATED_FAILURE_LIMIT,
  ComputerControlService,
  validateComputerAction
} from '../ComputerControlService'
import type { ComputerControlTarget } from '../ComputerControlTarget'

const saveImage = vi.hoisted(() => vi.fn<() => Promise<string>>())

vi.mock('../../conversations/ConversationAssetStore', () => ({
  conversationAssetStore: { saveImage }
}))

const screenshot: ChatImageInput = {
  path: 'index.html',
  name: 'preview.png',
  mimeType: 'image/png',
  dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
  sizeBytes: 8
}

function target(): ComputerControlTarget & {
  actions: ValidatedComputerAction[]
  captureCount: number
  closeTarget(): void
  resize(width: number, height: number): void
} {
  let alive = true
  let width = 800
  let height = 600
  const listeners = new Set<() => void>()
  const actions: ValidatedComputerAction[] = []
  let captureCount = 0
  return {
    actions,
    get captureCount() {
      return captureCount
    },
    describe: () => ({
      id: 'preview:index.html',
      scope: 'single-preview',
      path: 'index.html',
      title: 'Index',
      width,
      height
    }),
    capture: vi.fn((_signal: AbortSignal) => {
      captureCount += 1
      return Promise.resolve(screenshot)
    }),
    execute: vi.fn((action: ValidatedComputerAction, _signal: AbortSignal) => {
      actions.push(action)
      return Promise.resolve()
    }),
    isAlive: () => alive,
    close: () => {},
    onClosed: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    closeTarget: () => {
      alive = false
      for (const listener of listeners) listener()
    },
    resize: (nextWidth, nextHeight) => {
      width = nextWidth
      height = nextHeight
    }
  }
}

describe('ComputerControlService', () => {
  beforeEach(() => {
    saveImage.mockReset().mockResolvedValue('message-preview.png')
  })

  it('validates typed actions against the latest preview bounds', () => {
    expect(
      validateComputerAction({ type: 'click', x: 799, y: 599 }, { width: 800, height: 600 })
    ).toEqual({ type: 'click', x: 799, y: 599 })
    expect(() =>
      validateComputerAction({ type: 'click', x: 800, y: 1 }, { width: 800, height: 600 })
    ).toThrow('coordinate x')
    expect(() =>
      validateComputerAction(
        { type: 'javascript', source: 'alert(1)' },
        { width: 800, height: 600 }
      )
    ).toThrow('supported typed action')
  })

  it('records rejected action requests as durable errors without preserving their payload', async () => {
    const service = new ComputerControlService()
    await service.start('conversation', target())

    await expect(
      service.assess('conversation', { type: 'javascript', source: 'alert(1)' })
    ).rejects.toThrow('supported typed action')

    expect(service.get('conversation')?.audit).toMatchObject([
      { action: { type: 'invalid' }, status: 'error' }
    ])
  })

  it('records a target-policy rejection before an input can execute', async () => {
    const service = new ComputerControlService()
    const preview = target()
    preview.assessAction = vi.fn(() =>
      Promise.reject(new Error('That control is outside the enabled surface.'))
    )
    await service.start('conversation', preview)

    await expect(service.assess('conversation', { type: 'click', x: 10, y: 10 })).rejects.toThrow(
      'outside the enabled surface'
    )
    expect(preview.actions).toEqual([])
    expect(service.get('conversation')?.audit).toMatchObject([
      { action: { type: 'click', x: 10, y: 10 }, status: 'error' }
    ])
  })

  it('persists a post-action screenshot and records a durable audit entry', async () => {
    const service = new ComputerControlService()
    const preview = target()
    await service.start('conversation', preview)

    const outcome = await service.perform('conversation', 'message', {
      type: 'click',
      x: 10,
      y: 20
    })

    expect(preview.actions).toEqual([{ type: 'click', x: 10, y: 20 }])
    expect(saveImage).toHaveBeenCalledWith('conversation', 'message', screenshot)
    expect(outcome.asset).toEqual({ conversationId: 'conversation', id: 'message-preview.png' })
    expect(service.get('conversation')?.audit).toMatchObject([
      { action: { type: 'click', x: 10, y: 20 }, status: 'success', screenshot: outcome.asset }
    ])
  })

  it('captures one initial observation for the first vision-model round', async () => {
    const service = new ComputerControlService()
    await service.start('conversation', target())
    expect(service.takePendingObservation('conversation')).toEqual(screenshot)
    expect(service.takePendingObservation('conversation')).toBeNull()
  })

  it('assesses consequential actions before execution and records a denial', async () => {
    const service = new ComputerControlService()
    const preview = target()
    preview.assessAction = vi.fn(() => Promise.resolve('Activate “Save” in the controlled preview'))
    await service.start('conversation', preview)

    const assessment = await service.assess('conversation', { type: 'click', x: 10, y: 10 })
    expect(assessment.approvalDetail).toContain('Save')
    service.deny('conversation', assessment.action, 'Denied by user')

    expect(preview.actions).toEqual([])
    expect(service.get('conversation')?.audit).toMatchObject([
      { status: 'denied', detail: 'Denied by user' }
    ])
  })

  it('cancels an in-flight action when the session is stopped', async () => {
    const service = new ComputerControlService()
    const preview = target()
    preview.execute = vi.fn(
      (_action: ValidatedComputerAction, signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
    )
    await service.start('conversation', preview)
    const running = service.perform('conversation', 'message', { type: 'wait', durationMs: 10 })
    service.stopConversation('conversation', 'user-stop')
    await expect(running).rejects.toThrow('aborted')
  })

  it('ends safely when the target closes', async () => {
    const service = new ComputerControlService()
    const preview = target()
    await service.start('conversation', preview)
    preview.closeTarget()
    expect(service.get('conversation')).toBeNull()
    expect(service.hasActiveVisionSession('conversation')).toBe(false)
  })

  it('enforces the action budget before another input reaches the target', async () => {
    const service = new ComputerControlService()
    const preview = target()
    const session = await service.start('conversation', preview)
    for (let index = 0; index < session.budget.actionLimit; index += 1) {
      await service.perform('conversation', `message${index}`, { type: 'click', x: 1, y: 1 })
    }
    await expect(
      service.perform('conversation', 'last', { type: 'click', x: 1, y: 1 })
    ).rejects.toThrow('action limit')
    expect(preview.actions).toHaveLength(session.budget.actionLimit)
  })

  it('revalidates coordinates against the current visible target bounds', async () => {
    const service = new ComputerControlService()
    const preview = target()
    await service.start('conversation', preview)
    preview.resize(100, 100)

    await expect(
      service.perform('conversation', 'message', { type: 'click', x: 300, y: 300 })
    ).rejects.toThrow('coordinate x')
    expect(preview.actions).toEqual([])
  })

  it('ends when the hard session time limit expires', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValue(301_001)
    const service = new ComputerControlService()
    await service.start('conversation', target())
    await expect(
      service.perform('conversation', 'message', { type: 'screenshot' })
    ).rejects.toThrow('time limit')
    expect(service.get('conversation')).toBeNull()
    clock.mockRestore()
  })

  it('ends after a bounded number of repeated action failures', async () => {
    const service = new ComputerControlService()
    const preview = target()
    preview.execute = vi.fn(() => Promise.reject(new Error('Preview did not respond')))
    await service.start('conversation', preview)

    for (let index = 0; index < COMPUTER_CONTROL_REPEATED_FAILURE_LIMIT; index += 1) {
      await expect(
        service.perform('conversation', `message${index}`, { type: 'click', x: 1, y: 1 })
      ).rejects.toThrow('Preview did not respond')
    }

    expect(service.get('conversation')).toBeNull()
  })

  it('supports a basic form workflow through click, type, and a fresh screenshot each step', async () => {
    const service = new ComputerControlService()
    const preview = target()
    await service.start('conversation', preview)
    await service.perform('conversation', 'message', { type: 'click', x: 25, y: 30 })
    await service.perform('conversation', 'message', { type: 'type', text: 'A safe title' })
    await service.perform('conversation', 'message', { type: 'click', x: 100, y: 500 })
    expect(preview.actions.map((action) => action.type)).toEqual(['click', 'type', 'click'])
    // One initial observation plus a post-action screenshot for each step.
    expect(preview.captureCount).toBe(4)
  })

  it('redacts typed content from the durable audit', async () => {
    const service = new ComputerControlService()
    await service.start('conversation', target())

    const outcome = await service.perform('conversation', 'message', {
      type: 'type',
      text: 'A safe title'
    })

    expect(outcome.audit.action).toEqual({ type: 'type', textLength: 12 })
    expect(JSON.stringify(service.get('conversation')?.audit)).not.toContain('A safe title')
  })
})
