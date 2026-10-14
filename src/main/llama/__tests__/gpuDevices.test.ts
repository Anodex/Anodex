import { describe, expect, it } from 'vitest'
import {
  isAppleSilicon,
  parseDeviceList,
  recommendableGpuMemory,
  resolveGpuMemory
} from '../gpuDevices'

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

  it('does not trust the sum when it covers more than one GPU and none could be listed', () => {
    // Measured: an RX 7900 XTX (24 GB) beside a Ryzen's integrated graphics,
    // with the listing unavailable, read 55 GB and `unifiedSize` 0 — enough to
    // advertise 70B models on a 24 GB card. Two named devices make the sum the
    // double count; unknown is the honest answer.
    expect(resolveGpuMemory([], { total: 55 * GB, unifiedSize: 0 }, 2)).toMatchObject({
      vramBytes: null,
      unified: false
    })
    // One named device is still the old reading.
    expect(resolveGpuMemory([], { total: 24 * GB, unifiedSize: 0 }, 1)).toMatchObject({
      vramBytes: 24 * GB
    })
  })

  it('reports no VRAM rather than zero when there is nothing to go on', () => {
    // `null` means unknown and callers treat it as such; `0` would read as a
    // machine with a GPU that has no memory.
    expect(resolveGpuMemory([], null)).toMatchObject({ vramBytes: null, unified: false })
  })
})

describe('recommendableGpuMemory', () => {
  const shared = { vramBytes: 16 * GB, unified: true }

  it("keeps Apple Silicon's unified memory", () => {
    expect(recommendableGpuMemory(shared, true)).toEqual(shared)
  })

  it("reports a PC's integrated graphics as no graphics memory", () => {
    // Its memory is system RAM, already counted; read as a card it would be
    // counted twice, and read as unified it would be Apple's kind.
    expect(recommendableGpuMemory(shared, false)).toEqual({ vramBytes: null, unified: false })
  })

  it('leaves a graphics card alone', () => {
    const card = { vramBytes: 8 * GB, unified: false }
    expect(recommendableGpuMemory(card, false)).toEqual(card)
  })
})

describe('isAppleSilicon', () => {
  it('knows an Apple Mac, natively and under Rosetta', () => {
    expect(isAppleSilicon('darwin', 'arm64', 'Apple M2')).toBe(true)
    expect(isAppleSilicon('darwin', 'x64', 'Apple M1 Pro')).toBe(true)
  })

  it('is not fooled by an Intel Mac or an ARM PC', () => {
    expect(isAppleSilicon('darwin', 'x64', 'Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz')).toBe(false)
    expect(isAppleSilicon('win32', 'arm64', 'Snapdragon(R) X Elite')).toBe(false)
    expect(isAppleSilicon('linux', 'arm64', '')).toBe(false)
  })
})
