/**
 * Runs in a short-lived utility process: start llama.cpp's backend, ask it
 * what GPUs it sees and how much memory they have, report back, and exit.
 *
 * Starting the backend loads node-llama-cpp and its GPU stack (on Vulkan, the
 * driver and LLVM with it), about 65MB that stays for the life of whatever
 * process loaded it. The main process used to do this just to show a GPU name
 * on the first-run card, so every launch without a local model paid for an
 * engine it never used. Here the memory goes back when the process exits.
 *
 * Built as its own entry (see `electron.vite.config.ts`), so it carries none of
 * the main process with it.
 */
import type { HardwareProbeReport } from './hardwareProbeProcess'

interface ParentPort {
  postMessage(message: unknown): void
}

async function probe(): Promise<HardwareProbeReport> {
  const nlc = await import('node-llama-cpp')
  const llama = await nlc.getLlama({ logLevel: nlc.LlamaLogLevel.error })
  const [gpuNames, vram] = await Promise.all([
    llama.getGpuDeviceNames().catch(() => [] as string[]),
    llama.getVramState().catch(() => null)
  ])
  return {
    gpuNames,
    vram: vram ? { total: vram.total, unifiedSize: vram.unifiedSize } : null
  }
}

const port = (process as unknown as { parentPort?: ParentPort }).parentPort

void probe()
  .then((report) => port?.postMessage({ ok: true, report }))
  .catch((error: unknown) =>
    port?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) })
  )
  // The backend holds native handles that can keep the event loop alive; the
  // answer has been sent, and exiting is what gives the memory back.
  .finally(() => setTimeout(() => process.exit(0), 50))
