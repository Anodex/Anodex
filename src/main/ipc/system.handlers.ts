import { app, ipcMain } from 'electron'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { IpcChannel } from '@shared/ipc'
import type { HardwareInfo, SystemInfo } from '@shared/system.types'
import { llamaService } from '../llama/LlamaService'
import { anodexVersion } from '../appVersion'
import { settingsStore } from '../settings/SettingsStore'

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const value = bytes / Math.pow(1024, i)
  return `${value.toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}

function getCpuName(): string {
  const cpus = os.cpus()
  if (cpus.length === 0) return 'Unknown CPU'
  return cpus[0].model.trim()
}

/**
 * Free space where models download, in bytes, as the user can use it.
 *
 * Measured at the models folder rather than the app's data folder, because the
 * user can point models at another drive, and that is where a download lands.
 * `bavail`, not `bfree`: `bfree` counts blocks reserved for the system, which an
 * ordinary user cannot write to, so it overstated room by several percent.
 */
export function getStorageFreeBytes(target: string | undefined): number | null {
  const candidates = [target, app.getPath('userData'), os.homedir()].filter((dir): dir is string =>
    Boolean(dir)
  )
  for (const candidate of candidates) {
    // A models folder that does not exist yet is measured at its nearest existing parent.
    let dir = candidate
    while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir)
    try {
      const stats = fs.statfsSync(dir)
      return Number(stats.bavail) * Number(stats.bsize)
    } catch {
      // try the next place
    }
  }
  return null
}

function getOsLabel(): string {
  const platformNames: Record<string, string> = {
    win32: 'Windows',
    darwin: 'macOS',
    linux: 'Linux'
  }
  const name = platformNames[process.platform] ?? process.platform
  return `${name} ${os.release()} (${os.arch()})`
}

function getGpuDriver(): string | null {
  if (process.platform === 'win32') {
    try {
      const output = execSync(
        'powershell -NoProfile -Command "& {Get-CimInstance Win32_VideoController | Select-Object -First 1 -ExpandProperty DriverVersion}"',
        { timeout: 5000, encoding: 'utf8' }
      ).trim()
      if (output) return output
    } catch {
      /* fall through */
    }
    try {
      const output = execSync('nvidia-smi --query-gpu=driver_version --format=csv,noheader', {
        timeout: 5000,
        encoding: 'utf8'
      }).trim()
      if (output) return output
    } catch {
      /* noop */
    }
    return null
  }
  if (process.platform === 'linux') {
    try {
      const output = execSync('nvidia-smi --query-gpu=driver_version --format=csv,noheader', {
        timeout: 5000,
        encoding: 'utf8'
      }).trim()
      if (output) return output
    } catch {
      /* noop */
    }
    return null
  }
  return null
}

export async function getHardware(): Promise<HardwareInfo> {
  const probe = await llamaService.getHardwareProbe()
  const storageFreeBytes = getStorageFreeBytes(settingsStore.get().modelsDirectory)
  return {
    cpu: getCpuName(),
    cores: os.cpus().length,
    ram: formatBytes(os.totalmem()),
    ramBytes: os.totalmem(),
    os: getOsLabel(),
    gpu: probe.gpuNames[0] ?? null,
    gpuDriver: getGpuDriver(),
    vram: probe.vramBytes ? formatBytes(probe.vramBytes) : null,
    vramBytes: probe.vramBytes,
    unifiedMemory: probe.unified,
    storageFree: storageFreeBytes === null ? null : formatBytes(storageFreeBytes),
    storageFreeBytes
  }
}

/** IPC handler exposing host / build information for the About panel. */
export function registerSystemHandlers(): void {
  ipcMain.handle(IpcChannel.System.getInfo, (): SystemInfo => ({
    appVersion: anodexVersion,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
    userDataPath: app.getPath('userData')
  }))

  ipcMain.handle(IpcChannel.System.getHardwareInfo, (): Promise<HardwareInfo> => getHardware())
}
