import { describe, expect, it } from 'vitest'
import type { HardwareInfo } from '@shared/system.types'
import { CATALOG_FIXTURE } from '@shared/__tests__/fixtures/catalog'
import { buildRecommendedSlots } from '../scoring'

const GB = 1024 ** 3
const NOW = Date.parse('2026-09-16T00:00:00Z')

function machine(overrides: Partial<HardwareInfo>): HardwareInfo {
  return {
    cpu: 'Test CPU',
    cores: 8,
    ram: '16 GB',
    ramBytes: 16 * GB,
    os: 'Test OS',
    gpu: null,
    gpuDriver: null,
    vram: null,
    vramBytes: null,
    unifiedMemory: false,
    storageFree: null,
    ...overrides
  }
}

const overallFor = (hardware: HardwareInfo): string | undefined =>
  buildRecommendedSlots(hardware, undefined, CATALOG_FIXTURE, NOW).find(
    (slot) => slot.id === 'overall'
  )?.model.id

/**
 * "The best model for this computer" read as a question about the computer: the
 * same catalog should answer differently for a laptop and for a workstation, and
 * neither answer should be the smallest thing that happens to fit.
 */
describe('the model each machine is offered', () => {
  it('gives a small laptop something it can actually run', () => {
    const offered = overallFor(machine({ ramBytes: 8 * GB }))

    const model = CATALOG_FIXTURE.find((candidate) => candidate.id === offered)
    expect(model, 'a machine this size must still be offered something').toBeDefined()
    expect(model!.minRamGb).toBeLessThanOrEqual(8)
  })

  it('does not offer a workstation the same model as the laptop', () => {
    const laptop = overallFor(machine({ ramBytes: 8 * GB }))
    const workstation = overallFor(
      machine({ ramBytes: 64 * GB, vramBytes: 24 * GB, gpu: 'Test GPU' })
    )

    expect(workstation).not.toBe(laptop)
  })

  it('offers a machine with a big card a model that uses it', () => {
    const offered = overallFor(machine({ ramBytes: 64 * GB, vramBytes: 24 * GB, gpu: 'Test GPU' }))

    const model = CATALOG_FIXTURE.find((candidate) => candidate.id === offered)
    // Anything under a quarter of a 24GB card leaves most of the machine idle.
    expect(model!.minRamGb).toBeGreaterThanOrEqual(16)
  })
})
