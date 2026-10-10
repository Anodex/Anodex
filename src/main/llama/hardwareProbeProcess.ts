import { join } from 'node:path'
import { utilityProcess } from 'electron'
import { createLogger } from '../utils/logger'

const log = createLogger('llama:hardware')

/** Starting a GPU backend is slow on a cold driver cache; longer than this is a hang. */
const PROBE_TIMEOUT_MS = 30_000

/** What the probe process reports: llama.cpp's GPU names and its aggregate memory reading. */
export interface HardwareProbeReport {
  gpuNames: string[]
  vram: { total: number; unifiedSize: number } | null
}

/** The slice of Electron's `UtilityProcess` this uses, so tests can stand one in. */
export interface ProbeChild {
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  kill(): boolean
}

export type ForkProbe = (scriptPath: string) => ProbeChild

/**
 * Probe the GPUs in a utility process that exits once it has answered, so the
 * backend it starts never stays in the main process. Resolves null if the
 * process fails, crashes, or takes too long; the caller then falls back to
 * probing in-process, which is slower to give back but always worked.
 */
export function probeHardwareInChild(
  fork: ForkProbe = defaultFork,
  scriptPath = join(__dirname, 'hardwareProbeWorker.js')
): Promise<HardwareProbeReport | null> {
  return new Promise((resolve) => {
    const giveUp = (reason: string): void => {
      log.warn('Hardware probe process failed, probing in-process instead:', reason)
      resolve(null)
    }
    let child: ProbeChild
    try {
      child = fork(scriptPath)
    } catch (error) {
      giveUp(error instanceof Error ? error.message : String(error))
      return
    }
    let settled = false
    const finish = (report: HardwareProbeReport | null, reason?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (reason) giveUp(reason)
      else resolve(report)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(null, `no answer in ${PROBE_TIMEOUT_MS / 1000}s`)
    }, PROBE_TIMEOUT_MS)
    child.on('message', (message) => {
      const reply = message as { ok?: boolean; report?: HardwareProbeReport; error?: string }
      if (reply.ok && reply.report) finish(reply.report)
      else finish(null, reply.error ?? 'malformed reply')
    })
    child.on('exit', (code) => finish(null, `exited with code ${code} before answering`))
  })
}

function defaultFork(scriptPath: string): ProbeChild {
  return utilityProcess.fork(scriptPath, [], { serviceName: 'Anodex hardware probe' })
}
