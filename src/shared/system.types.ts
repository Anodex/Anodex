/** Static host / build information surfaced in the UI (e.g. the About panel). */
export interface SystemInfo {
  appVersion: string
  electronVersion: string
  nodeVersion: string
  chromeVersion: string
  platform: NodeJS.Platform
  arch: string
  /** Directory where models and settings are stored. */
  userDataPath: string
}

/** Hardware information surfaced in AI & Models / Diagnostics settings. */
export interface HardwareInfo {
  /** CPU model name. */
  cpu: string
  /** Number of physical/logical cores. */
  cores: number
  /** Installed system memory, human readable. */
  ram: string
  /** Installed system memory in bytes, for hardware-based recommendations. */
  ramBytes: number
  /** Operating system and version summary. */
  os: string
  /** Primary GPU name, if detectable. */
  gpu: string | null
  /** GPU driver version, if detectable. */
  gpuDriver: string | null
  /** Detected VRAM, if detectable. */
  vram: string | null
  /** Detected total VRAM in bytes, or null if unknown. */
  vramBytes: number | null
  /** True on unified-memory systems (Apple Silicon). */
  unifiedMemory: boolean
  /** Free space on the user data volume, human readable. */
  storageFree: string | null
}
