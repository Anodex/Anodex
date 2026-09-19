import type { UpdateStatus } from '@shared/update.types'

/** Pure, split out of `AboutSettings.tsx` so it can be unit-tested without
 *  pulling in `window.anodex` (which only exists inside a real renderer). */
export function updateStatusText(status: UpdateStatus, now: number = Date.now()): string {
  switch (status.state) {
    case 'idle':
      return 'Not checked yet.'
    case 'checking':
      return 'Checking for updates…'
    case 'available':
      return `Version ${status.version} is available.`
    case 'not-available':
      // With when it looked, because the answer can be stale through no fault
      // of the check: GitHub serves the update feed through a CDN, so for some
      // minutes after a release this reports the previous one. "Latest version,
      // checked just now" is a claim somebody can weigh; "latest version" on
      // its own is one they can only take or leave.
      return `You're on the latest version, checked ${howLongAgo(now - status.checkedAt)}.`
    case 'downloading':
      return `Downloading update… ${status.percent}%`
    case 'verifying':
      return `Checking that version ${status.version} is genuine…`
    case 'downloaded':
      return `Version ${status.version} downloaded — restart to install.`
    case 'rejected':
      return `Version ${status.version} was not installed: ${status.reason}.`
    case 'error':
      return `Couldn't check for updates: ${status.message}`
  }
}

/**
 * "just now", "4 minutes ago", "3 hours ago".
 *
 * Coarse on purpose. The question this answers is "is that answer worth
 * trusting", and to a minute is more precision than that question has.
 */
function howLongAgo(elapsedMs: number): string {
  const minutes = Math.floor(elapsedMs / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes === 1) return 'a minute ago'
  if (minutes < 60) return `${minutes} minutes ago`
  const hours = Math.round(minutes / 60)
  return hours === 1 ? 'an hour ago' : `${hours} hours ago`
}
