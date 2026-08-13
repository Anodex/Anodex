import type { ComputerControlSettings } from '@shared/settings.types'

export interface DesktopControlEligibility {
  available: boolean
  reason?: string
}

/**
 * Desktop input is unreachable unless the user enables the dedicated setting,
 * the Windows backend exists, and callers ask for an explicit desktop session.
 */
export function desktopControlEligibility(
  settings: ComputerControlSettings,
  platform = process.platform,
  backendAvailable = false
): DesktopControlEligibility {
  if (!settings.desktopControlEnabled) {
    return {
      available: false,
      reason: 'Desktop control is disabled in Settings.'
    }
  }
  if (platform !== 'win32') {
    return {
      available: false,
      reason: 'Desktop control is planned only for an explicitly enabled Windows backend.'
    }
  }
  if (backendAvailable) return { available: true }
  return {
    available: false,
    reason: 'Desktop control needs the packaged Windows input backend before it can be enabled.'
  }
}
