import { afterEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  generating: false,
  running: false,
  waitingApproval: false,
  downloading: false
}))

vi.mock('../../chat/inflightGenerations', () => ({
  hasInflightGeneration: () => h.generating
}))
vi.mock('../../agents/AgentRunService', () => ({
  agentRunService: { isRunning: () => h.running }
}))
vi.mock('../../ipc/tools.handlers', () => ({
  hasWaitingConfirmation: () => h.waitingApproval
}))
vi.mock('../../llama/modelDownloader', () => ({
  hasActiveDownload: () => h.downloading
}))

const { nothingInFlight } = await import('../quietMoment')

afterEach(() => {
  h.generating = false
  h.running = false
  h.waitingApproval = false
  h.downloading = false
})

describe('whether Anodex could quit without taking anything with it', () => {
  it('says yes when nothing is happening', () => {
    expect(nothingInFlight()).toBe(true)
  })

  it.each([
    ['a reply being written', 'generating'],
    ['an agent run', 'running'],
    ['a prompt waiting to be approved', 'waitingApproval'],
    ['a model downloading', 'downloading']
  ] as const)('says no while there is %s', (_what, flag) => {
    h[flag] = true

    expect(nothingInFlight()).toBe(false)
  })
})
