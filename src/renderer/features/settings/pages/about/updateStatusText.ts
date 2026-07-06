import type { UpdateStatus } from '@shared/update.types'

/** Pure, split out of `AboutSettings.tsx` so it can be unit-tested without
 *  pulling in `window.anodex` (which only exists inside a real renderer). */
export function updateStatusText(status: UpdateStatus): string {
  switch (status.state) {
    case 'idle':
      return 'Not checked yet.'
    case 'checking':
      return 'Checking for updates…'
    case 'available':
      return `Version ${status.version} is available.`
    case 'not-available':
      return "You're on the latest version."
    case 'downloading':
      return `Downloading update… ${status.percent}%`
    case 'downloaded':
      return `Version ${status.version} downloaded — restart to install.`
    case 'error':
      return `Couldn't check for updates: ${status.message}`
  }
}
