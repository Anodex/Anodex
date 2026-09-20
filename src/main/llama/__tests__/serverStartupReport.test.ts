import { describe, expect, it } from 'vitest'
import { summarizeServerStartup } from '../serverStartupReport'

/**
 * Lines copied verbatim from a real `-lv 4` startup transcript of the pinned
 * binary (b10549) on the machine this was investigated on, trimmed to the
 * interesting parts and to one duplicate of the report — llama.cpp prints the
 * whole thing twice, once while probing how the model would fit and once for
 * the real load.
 */
const OUTPUT = `
0.00.126.310 I cmn  common_param: common_params_print_info: build 10549 (b2e5e9b28) with Clang 20.1.8 for Windows x86_64
0.00.126.315 I cmn  common_param: common_params_print_info: verbosity = 4 (adjust with the \`-lv N\` CLI arg)
0.00.126.316 I cmn  common_param: device_info:
0.00.128.116 I cmn  common_param:   - Vulkan0 : AMD Radeon RX 7900 XTX (24560 MiB, 22033 MiB free)
0.00.129.683 I cmn  common_param:   - CPU     : AMD Ryzen 9 7900X 12-Core Processor             (64660 MiB, 24864 MiB free)
0.00.129.722 I cmn  common_param: system_info: n_threads = 12 (n_threads_batch = 12) / 24 | CPU : SSE3 = 1
0.00.129.759 I srv          init: running without SSL
0.00.130.511 I srv          init: The UI is disabled
0.00.279.782 I print_info: n_ctx_train           = 262144
0.00.528.368 I print_info: model params          = 4.02 B
0.00.626.826 I load_tensors: offloaded 0/37 layers to GPU
0.00.626.829 I load_tensors:   CPU_Mapped model buffer size =  2375.91 MiB
0.00.630.726 I llama_context: n_ctx                 = 4096
0.00.630.727 I llama_context: n_ctx_seq             = 4096
0.00.630.729 I llama_context: flash_attn            = auto
0.00.630.729 I llama_context: kv_unified            = false
0.00.630.740 I llama_context: n_ctx_seq (4096) < n_ctx_train (262144) -- the full capacity of the model will not be utilized
0.00.631.126 I llama_kv_cache:        CPU KV buffer size =   576.00 MiB
0.00.885.510 I load_tensors: offloaded 0/37 layers to GPU
0.01.268.823 I srv    load_model: initializing, n_slots = 1, n_ctx_slot = 4096, kv_unified = 'false'
0.01.727.047 I srv  llama_server: model loaded
0.01.727.054 I srv  llama_server: listening on http://127.0.0.1:60014
`

describe('summarizeServerStartup', () => {
  it('keeps the lines that decide how fast every later reply will be', () => {
    const lines = summarizeServerStartup(OUTPUT)

    expect(lines).toContain('load_tensors: offloaded 0/37 layers to GPU')
    expect(lines).toContain('llama_kv_cache:        CPU KV buffer size =   576.00 MiB')
    expect(lines).toContain('llama_context: n_ctx                 = 4096')
    expect(lines).toContain(
      "srv    load_model: initializing, n_slots = 1, n_ctx_slot = 4096, kv_unified = 'false'"
    )
  })

  it('keeps what llama.cpp found to run on, and how much room it had', () => {
    const lines = summarizeServerStartup(OUTPUT)

    expect(lines).toContain(
      'cmn  common_param:   - Vulkan0 : AMD Radeon RX 7900 XTX (24560 MiB, 22033 MiB free)'
    )
    expect(lines.some((line) => line.includes('n_threads = 12'))).toBe(true)
  })

  it('strips the log prefix so the report reads as llama.cpp wrote it', () => {
    expect(summarizeServerStartup(OUTPUT).every((line) => !/^\d+\.\d+/.test(line))).toBe(true)
  })

  it('prints the report once, though llama.cpp prints it twice', () => {
    const offloadLines = summarizeServerStartup(OUTPUT).filter((line) =>
      line.includes('offloaded 0/37')
    )

    // The two copies differ only in their timestamps — deduplicating on the raw
    // line kept both and doubled the summary.
    expect(offloadLines).toHaveLength(1)
  })

  it('leaves out the lines that say nothing about this load', () => {
    const lines = summarizeServerStartup(OUTPUT)

    // The model's trained window is a property of the file, and it sits right
    // beside `n_ctx`, which is the one that matters.
    expect(lines.some((line) => line.includes('n_ctx_train'))).toBe(false)
    expect(lines.some((line) => line.includes('running without SSL'))).toBe(false)
    expect(lines.some((line) => line.includes('The UI is disabled'))).toBe(false)
    expect(lines.some((line) => line.includes('listening on'))).toBe(false)
  })

  it('drops the per-tensor warnings a large model prints sixteen of', () => {
    const noisy = `
0.00.875.760 W model has unused tensor blk.64.attn_norm.weight (size = 20480 bytes) -- ignoring
0.00.875.787 W model has unused tensor blk.64.attn_q.weight (size = 51609600 bytes) -- ignoring
0.00.626.826 I load_tensors: offloaded 63/63 layers to GPU
`
    expect(summarizeServerStartup(noisy)).toEqual(['load_tensors: offloaded 63/63 layers to GPU'])
  })

  it('says nothing rather than something empty when nothing matched', () => {
    expect(summarizeServerStartup('')).toEqual([])
    expect(summarizeServerStartup('some unrelated output\nand more of it')).toEqual([])
  })

  it('stays short enough to read in a log', () => {
    const flood = Array.from(
      { length: 200 },
      (_, i) => `0.00.000.00${i} I llama_context: n_ctx = ${i}`
    ).join('\n')
    expect(summarizeServerStartup(flood).length).toBeLessThanOrEqual(32)
  })
})
