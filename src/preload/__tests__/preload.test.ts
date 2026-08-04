import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnodexApi } from '@shared/ipc'
import { IpcChannel } from '@shared/ipc'

/**
 * The preload's first behavioural coverage. `ipcContract.test.ts` reads this
 * file as source *text* to prove every declared channel is referenced, which is
 * a structural guard and says nothing about what the bridge actually hands the
 * renderer.
 *
 * What is worth pinning is the five-line `subscribe` helper — the only logic
 * here — because the promise this whole file exists to keep ("no `ipcRenderer`,
 * no Node APIs, and no channel strings leak into the renderer") is enforced
 * entirely by it and by what the API object contains.
 */

const mocks = vi.hoisted(() => ({
  exposed: [] as Array<{ key: string; value: unknown }>,
  listeners: new Map<string, Array<(...args: unknown[]) => void>>(),
  invocations: [] as Array<{ channel: string; args: unknown[] }>
}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => mocks.exposed.push({ key, value })
  },
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => {
      mocks.invocations.push({ channel, args })
      return Promise.resolve()
    },
    on: (channel: string, handler: (...args: unknown[]) => void) => {
      const existing = mocks.listeners.get(channel) ?? []
      existing.push(handler)
      mocks.listeners.set(channel, existing)
    },
    removeListener: (channel: string, handler: (...args: unknown[]) => void) => {
      const existing = mocks.listeners.get(channel) ?? []
      mocks.listeners.set(
        channel,
        existing.filter((entry) => entry !== handler)
      )
    }
  },
  webUtils: { getPathForFile: () => '/picked/path' }
}))

await import('../index')

/** Deliver a main→renderer message the way Electron would, event object first. */
function emit(channel: string, payload: unknown): void {
  const event = { sender: 'the real ipcRenderer', ports: [] }
  for (const handler of mocks.listeners.get(channel) ?? []) handler(event, payload)
}

function api(): AnodexApi {
  const entry = mocks.exposed.find((item) => item.key === 'anodex')
  if (!entry) throw new Error('The preload exposed nothing under "anodex".')
  return entry.value as AnodexApi
}

beforeEach(() => {
  mocks.listeners.clear()
  mocks.invocations.length = 0
})

describe('the preload bridge', () => {
  it('exposes exactly one thing, and it is the API', () => {
    expect(mocks.exposed).toHaveLength(1)
    expect(mocks.exposed[0].key).toBe('anodex')
    expect(typeof api().chat.send).toBe('function')
  })

  it('puts nothing on the surface but namespaces of functions', () => {
    // The guard against someone adding `ipcRenderer`, a channel constant, or a
    // raw Electron object to the object handed across the bridge.
    for (const [namespace, group] of Object.entries(api())) {
      expect(typeof group, namespace).toBe('object')
      for (const [name, member] of Object.entries(group as Record<string, unknown>)) {
        expect(typeof member, `${namespace}.${name}`).toBe('function')
      }
    }
  })
})

describe('the preload bridge — main→renderer subscriptions', () => {
  it('never hands the renderer the event object', () => {
    // `IpcRendererEvent` carries `sender`. Forwarding it would put a live
    // send-capable handle into renderer code and undo the entire point of the
    // bridge, so the listener must see the payload and nothing else.
    const seen: unknown[][] = []
    api().models.onStateChanged((...args: unknown[]) => seen.push(args))

    emit(IpcChannel.Models.stateChanged, { status: 'ready' })

    expect(seen).toEqual([[{ status: 'ready' }]])
  })

  it('stops delivering once unsubscribed', () => {
    const seen: unknown[] = []
    const unsubscribe = api().models.onStateChanged((payload) => seen.push(payload))

    emit(IpcChannel.Models.stateChanged, 'first')
    unsubscribe()
    emit(IpcChannel.Models.stateChanged, 'second')

    expect(seen).toEqual(['first'])
  })

  it('unsubscribes only its own listener, not everyone on the channel', () => {
    // Two stores subscribe to the same channel routinely; one unmounting must
    // not silence the other.
    const first: unknown[] = []
    const second: unknown[] = []
    const stopFirst = api().models.onStateChanged((payload) => first.push(payload))
    api().models.onStateChanged((payload) => second.push(payload))

    stopFirst()
    emit(IpcChannel.Models.stateChanged, 'after')

    expect(first).toEqual([])
    expect(second).toEqual(['after'])
  })

  it('survives being unsubscribed twice', () => {
    const unsubscribe = api().models.onStateChanged(() => {})

    unsubscribe()
    expect(() => unsubscribe()).not.toThrow()
  })
})

describe('the preload bridge — invocations', () => {
  it('sends the channel the renderer never sees, with its arguments in order', () => {
    void api().conversations.deleteArchived(['a', 'b'])

    expect(mocks.invocations).toEqual([
      { channel: IpcChannel.Conversations.deleteArchived, args: [['a', 'b']] }
    ])
  })

  it('defaults an omitted request rather than sending undefined', () => {
    // `listThreads` is the one method with a default parameter; the main
    // handler reads fields off it.
    void api().email.listThreads()

    expect(mocks.invocations[0]).toEqual({ channel: IpcChannel.Email.listThreads, args: [{}] })
  })
})
