import type { PermissionMode } from '@shared/settings.types'
import type { IconName } from '../../../components/Icon'

/**
 * The permission modes as the composer's menu offers them. Their own module so
 * the first-run tour lists the same modes, names, and descriptions the menu
 * does, rather than a copy that goes stale when one is renamed.
 */
export const PERMISSION_MODES: PermissionMode[] = ['ask', 'full', 'untethered']

export const PERMISSION_ACTIVE_CLASS: Record<PermissionMode, string> = {
  ask: 'permActiveAsk',
  full: 'permActiveFull',
  untethered: 'permActiveUntethered'
}

export function permissionIcon(mode: PermissionMode): IconName {
  if (mode === 'untethered') return 'unlock-keyhole'
  if (mode === 'full') return 'shield-check'
  return 'shield-question'
}

export function permissionLabel(mode: PermissionMode): string {
  if (mode === 'untethered') return 'Untethered'
  // Stored as `full`. Shown as Edits because that is what it allows: "Full" read as
  // everything allowed, the one thing this mode is not, so it went unused.
  if (mode === 'full') return 'Edits'
  return 'Ask'
}

export function permissionDescription(mode: PermissionMode): string {
  if (mode === 'untethered') return 'auto-runs safe and sensitive actions'
  if (mode === 'full') return 'edits files and runs read-only checks, asks before other commands'
  return 'asks before writes and shell commands'
}
