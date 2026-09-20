import { execFile } from 'node:child_process'
import { delimiter, dirname } from 'node:path'
import { promisify } from 'node:util'
import { createLogger } from '../utils/logger'
import { resolveLlamaServerBinary } from './LlamaServerRuntime'

const log = createLogger('llama:devices')
const execFileAsync = promisify(execFile)
/** Listing devices loads no model; anything slower than this is a fault, not work. */
const LIST_TIMEOUT_MS = 15_000

/** One GPU llama.cpp can offload to, as it reports itself. */
export interface GpuDevice {
  /** llama.cpp's own handle, e.g. `Vulkan0` — the value `--device` takes. */
  id: string
  name: string
  totalBytes: number
  freeBytes: number
}

const MIB = 1024 * 1024
/** `  Vulkan0: AMD Radeon RX 7900 XTX (24560 MiB, 22532 MiB free)` */
const DEVICE_LINE = /^\s*(\S+?):\s*(.+?)\s*\((\d+)\s*MiB,\s*(\d+)\s*MiB free\)\s*$/

/**
 * Read `llama-server --list-devices` output into one entry per GPU.
 *
 * Pure, so the shape of the output can be tested without a GPU. A line that
 * does not match is skipped rather than failing the listing: the header and
 * any future additions are not devices, and a probe that throws on an unknown
 * line would take hardware detection down with it.
 */
export function parseDeviceList(output: string): GpuDevice[] {
  const devices: GpuDevice[] = []
  for (const line of output.split(/\r?\n/)) {
    const match = DEVICE_LINE.exec(line)
    if (!match) continue
    devices.push({
      id: match[1],
      name: match[2],
      totalBytes: Number(match[3]) * MIB,
      freeBytes: Number(match[4]) * MIB
    })
  }
  return devices
}

/**
 * How much graphics memory this machine really has for one model, and whether
 * that memory is the system's own.
 *
 * ## Why this is not just `getVramState()`
 *
 * node-llama-cpp reports one aggregate across every device, and its own
 * documentation says to detect a unified-memory machine with
 * `getVramState().unifiedSize > 0`. Both are wrong on the very common case of
 * a desktop with a graphics card *and* an integrated GPU, because the
 * integrated one's memory **is** system RAM:
 *
 * ```
 * getVramState() -> { total: 71.4 GB, unifiedSize: 55.6 GB }
 * --list-devices -> Vulkan0: AMD Radeon RX 7900 XTX  (24560 MiB)
 *                   Vulkan1: AMD Radeon(TM) Graphics (48532 MiB)
 * ```
 *
 * Measured on that machine, Anodex believed it had 71.4 GB of VRAM — the card
 * plus 47 GB of the same system memory already counted as RAM — and, because
 * `unifiedSize` was above zero, that the whole machine was unified memory. The
 * consequences all point the same way: `recommendModel` decided there was no
 * dedicated GPU at all, `isModelHardwareCompatible` stopped checking VRAM
 * because unified machines skip that gate, and the scorer's "runs fast in"
 * figure became 70% of system RAM instead of the card.
 *
 * ## The rule
 *
 * The first device is the one llama.cpp offloads to by default and names in
 * its own load report ("using device Vulkan0"), so its memory is the capacity
 * a model actually has. Deliberately not the sum — that is the double count —
 * and deliberately not the largest either, since on this machine the largest
 * device is the integrated one.
 *
 * A machine is unified when the memory really is shared: the backend says
 * there is unified memory *and* there is only one device to be unified with.
 * Apple Silicon and integrated-only machines answer yes; a card beside an
 * integrated GPU answers no, which is the case that was wrong.
 */
export interface GpuMemory {
  vramBytes: number | null
  unified: boolean
  devices: GpuDevice[]
}

/**
 * Refine an aggregate VRAM reading with llama.cpp's per-device listing.
 *
 * Falls back to the aggregate untouched when the listing is empty, so a
 * platform or build that cannot list devices behaves exactly as before.
 */
export function resolveGpuMemory(
  devices: GpuDevice[],
  aggregate: { total: number; unifiedSize: number } | null
): GpuMemory {
  if (devices.length === 0) {
    return {
      vramBytes: aggregate ? aggregate.total : null,
      unified: aggregate ? aggregate.unifiedSize > 0 : false,
      devices
    }
  }
  return {
    vramBytes: devices[0].totalBytes,
    unified: (aggregate?.unifiedSize ?? 0) > 0 && devices.length === 1,
    devices
  }
}

let cached: Promise<GpuDevice[]> | null = null

/**
 * Ask the bundled llama.cpp which GPUs it can see.
 *
 * Cached for the life of the process: the answer is about the machine, the
 * call spawns a process, and hardware detection runs on more than one screen.
 * Never throws — a machine whose devices cannot be listed falls back to the
 * aggregate reading rather than losing hardware detection entirely.
 */
export async function listGpuDevices(): Promise<GpuDevice[]> {
  cached ??= (async () => {
    try {
      const binaryPath = await resolveLlamaServerBinary()
      const binaryDir = dirname(binaryPath)
      // Same library-path handling as starting the server proper: the binary
      // loads its backends from beside itself.
      const libraryPathKey =
        process.platform === 'win32'
          ? 'PATH'
          : process.platform === 'darwin'
            ? 'DYLD_LIBRARY_PATH'
            : 'LD_LIBRARY_PATH'
      const currentLibraryPath = process.env[libraryPathKey] ?? ''
      const { stdout, stderr } = await execFileAsync(binaryPath, ['--list-devices'], {
        cwd: binaryDir,
        timeout: LIST_TIMEOUT_MS,
        windowsHide: true,
        env: {
          ...process.env,
          [libraryPathKey]: currentLibraryPath
            ? `${binaryDir}${delimiter}${currentLibraryPath}`
            : binaryDir
        }
      })
      const devices = parseDeviceList(`${stdout}\n${stderr}`)
      log.info('GPU devices', devices.map((device) => `${device.id}: ${device.name}`).join(', '))
      return devices
    } catch (error) {
      log.warn('Could not list GPU devices; falling back to the aggregate reading:', error)
      return []
    }
  })()
  return cached
}

/** Forget the cached listing — for tests, and for a deliberate re-detect. */
export function resetGpuDeviceCacheForTests(): void {
  cached = null
}
