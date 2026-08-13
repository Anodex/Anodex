import type { VisualPreviewAssetRef } from './tools.types'

export interface ComputerControlPoint {
  x: number
  y: number
}

/** The only input vocabulary exposed to a model in a control session. */
export type ComputerAction =
  | { type: 'screenshot' }
  | { type: 'click'; x: number; y: number }
  | { type: 'double_click'; x: number; y: number }
  | { type: 'drag'; from: ComputerControlPoint; to: ComputerControlPoint; durationMs?: number }
  | { type: 'scroll'; deltaX?: number; deltaY: number }
  | { type: 'keypress'; keys: string[] }
  | { type: 'type'; text: string }
  | { type: 'wait'; durationMs: number }

/** A model action after Anodex has bounded each value for the preview target. */
export type ValidatedComputerAction = ComputerAction

export type ComputerControlSessionStatus = 'active' | 'paused' | 'stopped' | 'ended'

export type ComputerControlEndReason =
  | 'user-stop'
  | 'generation-stopped'
  | 'target-closed'
  | 'target-reloaded'
  | 'model-unloaded'
  | 'app-quit'
  | 'action-budget'
  | 'time-budget'
  | 'repeated-failure'
  | 'cancelled'
  | 'error'

export interface ComputerControlTargetInfo {
  id: string
  scope: ComputerControlScope
  path: string
  title: string
  width: number
  height: number
}

/** The user chooses the scope when starting a visible control session. */
export type ComputerControlScope =
  'single-preview' | 'project-preview' | 'anodex-file-viewer' | 'desktop'

export interface ComputerControlBudget {
  actionLimit: number
  actionsUsed: number
  timeLimitMs: number
  elapsedMs: number
}

export interface ComputerControlAuditEntry {
  id: string
  /** Safe-to-persist form of the action; typed text itself never reaches transcript JSON. */
  action: ComputerControlAuditAction
  status: 'success' | 'error' | 'denied'
  createdAt: number
  detail: string
  screenshot?: VisualPreviewAssetRef
}

export type ComputerControlAuditAction =
  | { type: 'invalid' }
  | { type: 'screenshot' }
  | { type: 'click'; x: number; y: number }
  | { type: 'double_click'; x: number; y: number }
  | { type: 'drag'; from: ComputerControlPoint; to: ComputerControlPoint; durationMs?: number }
  | { type: 'scroll'; deltaX?: number; deltaY: number }
  | { type: 'keypress'; keys: string[] }
  | { type: 'type'; textLength: number }
  | { type: 'wait'; durationMs: number }

export interface ComputerControlSession {
  id: string
  conversationId: string
  target: ComputerControlTargetInfo
  status: ComputerControlSessionStatus
  budget: ComputerControlBudget
  startedAt: number
  endedAt?: number
  endReason?: ComputerControlEndReason
  audit: ComputerControlAuditEntry[]
}

export interface StartComputerControlRequest {
  conversationId: string
  /** Preview is the default; the file-viewer surface is a separate allowlisted mode. */
  target?: 'preview' | 'file-viewer' | 'desktop'
  previewPath?: string
  desktopWindowHandle?: string
  /** Preview-only: allows links only to other HTML files confined to the same workspace. */
  scope?: 'single-preview' | 'project-preview'
}

/** A user-visible native window candidate for an explicitly enabled desktop session. */
export interface DesktopControlWindowInfo {
  handle: string
  processId: number
  processPath: string
  title: string
  bounds: ComputerControlPoint & { width: number; height: number }
}
