/**
 * The handful of lines in llama-server's startup output that decide how fast
 * every later reply will be.
 *
 * ## Why this is worth extracting
 *
 * `LlamaServerRuntime` captures the process's stdout/stderr, and surfaces it
 * only when something fails. On a load that *works*, llama.cpp's own account
 * of what it did — the layers it offloaded, how large the KV cache came out,
 * what context it settled on — was written and then discarded.
 *
 * Those are exactly the facts a "why is this slow" question turns on. A model
 * that quietly ran half on the CPU because the KV cache would not fit looked,
 * in the log, identical to one that fit perfectly.
 *
 * ## The lines only exist above the default verbosity
 *
 * This filter is paired with `-lv 4` in `LlamaServerRuntime`. At llama.cpp's
 * default verbosity of 3 none of the lines below are printed at all — the
 * whole startup transcript is about ninety lines of routing and warnings — so
 * without that flag this function correctly finds nothing, which is the worst
 * possible outcome for a diagnostic. The fragments here were read off a real
 * `-lv 4` transcript from the pinned binary (b10549), not guessed.
 *
 * Deliberately a filter over lines llama.cpp already prints rather than a
 * parser of them: the wording changes between builds, and a summary that
 * silently reported nothing after an upstream rename would be worse than no
 * summary. Matching loosely and printing the line verbatim degrades to "fewer
 * lines", never to "wrong numbers".
 */

/**
 * Fragments that mark a line as worth keeping, matched case-insensitively.
 *
 * Each one is here because it answers a question that gets asked, and each was
 * observed in a real transcript:
 * - `offloaded` — `load_tensors: offloaded 0/37 layers to GPU`
 * - `buffer size` — the model, KV, output and per-device compute buffers,
 *   which is also where the device names appear (`Vulkan0`, `CPU_Mapped`)
 * - `device_info` / `mib free` — the devices llama.cpp found and how much room
 *   each had left, which is what decides an offload that silently fell back
 * - `n_threads` — what the CPU side was given
 * - `vulkan devices` / `ggml_vulkan` — what llama.cpp found to run on
 * - `n_ctx`, `n_ctx_seq`, `n_ctx_slot`, `n_seq_max`, `n_batch`, `n_ubatch`,
 *   `kv_unified` — the window and batching actually in force
 * - `flash_attn`, `model params`, `model size` — the rest of the shape
 */
const INTERESTING = [
  'ggml_vulkan',
  'ggml_cuda',
  'ggml_metal',
  'vulkan devices',
  'device_info',
  'mib free',
  'n_threads',
  'offloaded',
  'offloading',
  'buffer size',
  'n_ctx ',
  'n_ctx  ',
  'n_ctx_seq',
  'n_ctx_slot',
  'n_seq_max',
  'n_batch',
  'n_ubatch',
  'kv_unified',
  'flash_attn',
  'model params',
  'model size'
]

/**
 * Lines that match {@link INTERESTING} but say nothing about this load.
 *
 * `n_ctx_train` is a property of the file and sits directly beside `n_ctx`,
 * which is the one a slow reply turns on. `unused tensor` is a per-tensor
 * warning the 27B prints sixteen of.
 */
const NOISE = ['n_ctx_train', 'n_ctx_orig_yarn', 'unused tensor']

/** Keep the summary to something readable in a log, not a wall of lines. */
const MAX_LINES = 32

/**
 * llama.cpp's structured log prefix — `0.06.221.004 I ` — stripped for
 * comparison only.
 *
 * The report is printed twice on every load: once while llama.cpp probes how
 * the model would fit, and once for the real load. The two copies differ only
 * in their timestamps, so deduplicating on the raw line kept both and doubled
 * the summary.
 */
const LOG_PREFIX = /^[\d.]+\s+[A-Z]\s+/

function messageOf(line: string): string {
  return line.replace(LOG_PREFIX, '')
}

/**
 * Pick the load-shaping lines out of llama-server's startup output.
 *
 * Returns an empty array when nothing matched, so a caller can skip logging
 * entirely rather than print an empty heading.
 */
export function summarizeServerStartup(output: string): string[] {
  const seen = new Set<string>()
  const kept: string[] = []
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const lower = line.toLowerCase()
    if (NOISE.some((fragment) => lower.includes(fragment))) continue
    if (!INTERESTING.some((fragment) => lower.includes(fragment))) continue
    const message = messageOf(line)
    if (seen.has(message)) continue
    seen.add(message)
    kept.push(message)
    if (kept.length >= MAX_LINES) break
  }
  return kept
}
