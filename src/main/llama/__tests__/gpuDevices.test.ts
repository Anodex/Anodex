import { describe, expect, it } from 'vitest'
import { parseDeviceList, resolveGpuMemory } from '../gpuDevices'

const GB = 1024 ** 3
const MIB = 1024 * 1024

/** Verbatim `llama-server --list-devices` from the machine this was found on. */
const TWO_DEVICES = `Available devices:
  Vulkan0: AMD Radeon RX 7900 XTX (24560 MiB, 22532 MiB free)
  Vulkan1: AMD Radeon(TM) Graphics (48532 MiB, 46105 MiB free)
`

describe('parseDeviceList', () => {
  it('reads each device llama.cpp offers', () => {
    expect(parseDeviceList(TWO_DEVICES)).toEqual([
      {
        id: 'Vulkan0',
        name: 'AMD Radeon RX 7900 XTX',
        totalBytes: 24_560 * MIB,
        freeBytes: 22_532 * MIB
      },
      {
        id: 'Vulkan1',
        name: 'AMD Radeon(TM) Graphics',
        totalBytes: 48_532 * MIB,
        freeBytes: 46_105 * MIB
      }
    ])
  })

  it('keeps a name with brackets and spaces intact', () => {
    expect(parseDeviceList(TWO_DEVICES)[1].name).toBe('AMD Radeon(TM) Graphics')
  })

  it('skips anything that is not a device line', () => {
    // The heading is not a device, and neither is whatever a future build
    // decides to print alongside one. Throwing on an unrecognised line would
    // take hardware detection down with it.
    const output = `Available devices:
  Vulkan0: Test GPU (1024 MiB, 512 MiB free)
note: something new upstream added
`
    expect(parseDeviceList(output)).toHaveLength(1)
  })

  it('finds nothing in empty or unrelated output', () => {
    expect(parseDeviceList('')).toEqual([])
    expect(parseDeviceList('ggml_vulkan: no devices found\n')).toEqual([])
  })
})

describe('resolveGpuMemory', () => {
  const devices = parseDeviceList(TWO_DEVICES)

  /**
   * The bug. `getVramState()` sums every device, and the integrated GPU's
   * memory is system RAM — already counted as `ramBytes`. Measured on the
   * reporting machine, Anodex believed it had 71.4 GB of VRAM and, because
   * `unifiedSize` was above zero, that the whole machine was unified memory.
   */
  it('reports the card, not the card plus the system memory beside it', () => {
    const memory = resolveGpuMemory(devices, { total: 71.4 * GB, unifiedSize: 55.6 * GB })

    expect(memory.vramBytes).toBe(24_560 * MIB)
    expect(memory.unified).toBe(false)
  })

  it('takes the first device rather than the largest', () => {
    // The integrated GPU here is the bigger of the two. llama.cpp offloads to
    // device 0 and says so in its own load report ("using device Vulkan0"), so
    // that is the capacity a model actually has.
    const memory = resolveGpuMemory(devices, { total: 71.4 * GB, unifiedSize: 55.6 * GB })

    expect(memory.vramBytes).toBeLessThan(devices[1].totalBytes)
  })

  it('leaves a single discrete card exactly as it was', () => {
    const one = parseDeviceList('  CUDA0: NVIDIA GeForce RTX 4090 (24564 MiB, 24000 MiB free)\n')
    const memory = resolveGpuMemory(one, { total: 24_564 * MIB, unifiedSize: 0 })

    expect(memory.vramBytes).toBe(24_564 * MIB)
    expect(memory.unified).toBe(false)
  })

  it('still calls a genuinely unified machine unified', () => {
    // Apple Silicon, and an integrated-only PC: one device, and the backend
    // says its memory is shared. Both answered yes before this change and
    // must keep answering yes.
    const one = parseDeviceList('  Metal0: Apple M3 Max (98304 MiB, 90000 MiB free)\n')
    const memory = resolveGpuMemory(one, { total: 98_304 * MIB, unifiedSize: 98_304 * MIB })

    expect(memory.unified).toBe(true)
    expect(memory.vramBytes).toBe(98_304 * MIB)
  })

  it('falls back to the aggregate untouched when nothing could be listed', () => {
    // A platform or build that cannot list devices must behave exactly as it
    // did before this existed, including the old unified rule.
    expect(resolveGpuMemory([], { total: 8 * GB, unifiedSize: 0 })).toMatchObject({
      vramBytes: 8 * GB,
      unified: false
    })
    expect(resolveGpuMemory([], { total: 8 * GB, unifiedSize: 8 * GB })).toMatchObject({
      unified: true
    })
  })

  it('reports no VRAM rather than zero when there is nothing to go on', () => {
    // `null` means unknown and callers treat it as such; `0` would read as a
    // machine with a GPU that has no memory.
    expect(resolveGpuMemory([], null)).toMatchObject({ vramBytes: null, unified: false })
  })
})
