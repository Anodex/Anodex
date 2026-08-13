import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { ChatImageInput } from '@shared/chat.types'
import type {
  ComputerAction,
  ComputerControlAuditAction,
  ComputerControlAuditEntry,
  ComputerControlEndReason,
  ComputerControlSession,
  ValidatedComputerAction
} from '@shared/computerControl.types'
import { conversationAssetStore } from '../conversations/ConversationAssetStore'
import type { ComputerControlTarget } from './ComputerControlTarget'

export const COMPUTER_CONTROL_ACTION_LIMIT = 25
export const COMPUTER_CONTROL_TIME_LIMIT_MS = 5 * 60_000
const MAX_WAIT_MS = 5_000
const MAX_DRAG_DURATION_MS = 2_000
const MAX_SCROLL_DELTA = 2_000
const MAX_TYPED_CHARS = 2_000
export const COMPUTER_CONTROL_REPEATED_FAILURE_LIMIT = 3

interface ActiveSession {
  session: ComputerControlSession
  target: ComputerControlTarget
  controller: AbortController
  inFlight: boolean
  unsubscribeClosed?: () => void
  pendingObservation?: ChatImageInput
  failedAction?: { signature: string; count: number }
}

export interface ComputerActionOutcome {
  action: ValidatedComputerAction
  screenshot: ChatImageInput
  asset?: { conversationId: string; id: string }
  audit: ComputerControlAuditEntry
}

export interface ComputerActionAssessment {
  action: ValidatedComputerAction
  approvalDetail: string | null
}

/**
 * Main-process owner for the tightly bounded Phase 1 preview-control loop.
 * Target enumeration and platform input remain outside this service; it owns
 * only a previously approved, narrow target adapter.
 */
export class ComputerControlService extends EventEmitter {
  private readonly sessions = new Map<string, ActiveSession>()

  async start(
    conversationId: string,
    target: ComputerControlTarget
  ): Promise<ComputerControlSession> {
    this.stopConversation(conversationId, 'user-stop')
    if (!target.isAlive()) throw new Error('The selected preview window is no longer open.')
    const now = Date.now()
    const session: ComputerControlSession = {
      id: randomUUID(),
      conversationId,
      target: target.describe(),
      status: 'active',
      startedAt: now,
      budget: {
        actionLimit: COMPUTER_CONTROL_ACTION_LIMIT,
        actionsUsed: 0,
        timeLimitMs: COMPUTER_CONTROL_TIME_LIMIT_MS,
        elapsedMs: 0
      },
      audit: []
    }
    const active: ActiveSession = {
      session,
      target,
      controller: new AbortController(),
      inFlight: false
    }
    target.setControlActive?.(true)
    active.unsubscribeClosed = target.onClosed?.(() =>
      this.stopConversation(conversationId, 'target-closed')
    )
    this.sessions.set(conversationId, active)
    try {
      // The model's first control round must begin with pixels, not a blind
      // coordinate guess. This session-owned image is consumed by the next
      // vision generation and never serialized into conversation JSON.
      active.pendingObservation = await target.capture(active.controller.signal)
    } catch (error) {
      this.stopConversation(conversationId, 'error')
      throw error
    }
    this.emit('changed', cloneSession(session))
    return cloneSession(session)
  }

  /** Consume the initial screenshot exactly once for the next vision round. */
  takePendingObservation(conversationId: string): ChatImageInput | null {
    const active = this.sessions.get(conversationId)
    if (!active || active.session.status !== 'active') return null
    const image = active.pendingObservation ?? null
    active.pendingObservation = undefined
    return image
  }

  async assess(
    conversationId: string,
    action: unknown,
    signal?: AbortSignal
  ): Promise<ComputerActionAssessment> {
    const active = this.getActiveSession(conversationId)
    this.refreshTargetInfo(active)
    this.ensureWithinTime(active)
    if (active.session.budget.actionsUsed >= active.session.budget.actionLimit) {
      this.stopConversation(conversationId, 'action-budget')
      throw new Error('The AI-control action limit has been reached.')
    }
    let validated: ValidatedComputerAction
    try {
      validated = validateComputerAction(action, active.session.target)
    } catch (error) {
      this.recordError(active, { type: 'invalid' }, error)
      throw error
    }
    const combined = raceSignals(active.controller.signal, signal)
    try {
      return {
        action: validated,
        approvalDetail: (await active.target.assessAction?.(validated, combined.signal)) ?? null
      }
    } catch (error) {
      this.recordError(active, auditAction(validated), error)
      throw error
    } finally {
      combined.dispose()
    }
  }

  deny(
    conversationId: string,
    action: ValidatedComputerAction,
    detail: string
  ): ComputerControlAuditEntry {
    const active = this.getActiveSession(conversationId)
    const audit: ComputerControlAuditEntry = {
      id: randomUUID(),
      action: auditAction(action),
      status: 'denied',
      createdAt: Date.now(),
      detail
    }
    active.session.audit.push(audit)
    this.emit('changed', cloneSession(active.session))
    return audit
  }

  get(conversationId: string): ComputerControlSession | null {
    const active = this.sessions.get(conversationId)
    if (!active) return null
    this.refreshElapsed(active.session)
    return cloneSession(active.session)
  }

  hasActiveVisionSession(conversationId: string): boolean {
    const active = this.sessions.get(conversationId)
    if (!active) return false
    this.refreshElapsed(active.session)
    return active.session.status === 'active' && active.target.isAlive()
  }

  pause(conversationId: string): ComputerControlSession | null {
    const active = this.sessions.get(conversationId)
    if (!active || active.session.status !== 'active')
      return active ? cloneSession(active.session) : null
    active.session.status = 'paused'
    this.emit('changed', cloneSession(active.session))
    return cloneSession(active.session)
  }

  resume(conversationId: string): ComputerControlSession | null {
    const active = this.sessions.get(conversationId)
    if (!active || active.session.status !== 'paused')
      return active ? cloneSession(active.session) : null
    this.ensureWithinTime(active)
    active.session.status = 'active'
    this.emit('changed', cloneSession(active.session))
    return cloneSession(active.session)
  }

  stopConversation(
    conversationId: string,
    reason: ComputerControlEndReason
  ): ComputerControlSession | null {
    const active = this.sessions.get(conversationId)
    if (!active) return null
    active.controller.abort()
    active.target.setControlActive?.(false)
    active.unsubscribeClosed?.()
    active.session.status = 'ended'
    active.session.endedAt = Date.now()
    active.session.endReason = reason
    this.refreshElapsed(active.session)
    this.sessions.delete(conversationId)
    const session = cloneSession(active.session)
    this.emit('changed', session)
    return session
  }

  stopTarget(targetId: string, reason: ComputerControlEndReason): void {
    for (const [conversationId, active] of this.sessions) {
      if (active.session.target.id === targetId) this.stopConversation(conversationId, reason)
    }
  }

  stopAll(reason: ComputerControlEndReason): void {
    for (const conversationId of [...this.sessions.keys()])
      this.stopConversation(conversationId, reason)
  }

  async perform(
    conversationId: string,
    messageId: string,
    action: unknown,
    signal?: AbortSignal
  ): Promise<ComputerActionOutcome> {
    const active = this.getActiveSession(conversationId)
    if (active.inFlight) throw new Error('A computer action is already in progress.')
    this.refreshTargetInfo(active)
    this.ensureWithinTime(active)
    if (active.session.budget.actionsUsed >= active.session.budget.actionLimit) {
      this.stopConversation(conversationId, 'action-budget')
      throw new Error('The AI-control action limit has been reached.')
    }

    let validated: ValidatedComputerAction
    try {
      validated = validateComputerAction(action, active.session.target)
    } catch (error) {
      this.recordError(active, { type: 'invalid' }, error)
      throw error
    }
    active.inFlight = true
    const combined = raceSignals(active.controller.signal, signal)
    try {
      if (validated.type !== 'screenshot') await active.target.execute(validated, combined.signal)
      active.session.budget.actionsUsed += 1
      const screenshot = await active.target.capture(combined.signal)
      // The next model action is based on this exact screenshot, so retain the
      // target's current bounds rather than accepting coordinates from an old
      // viewport after a user resizes a visible Anodex surface.
      this.refreshTargetInfo(active)
      const assetId = await conversationAssetStore.saveImage(conversationId, messageId, screenshot)
      const audit: ComputerControlAuditEntry = {
        id: randomUUID(),
        action: auditAction(validated),
        status: 'success',
        createdAt: Date.now(),
        detail: describeAction(validated),
        screenshot: { conversationId, id: assetId }
      }
      active.session.audit.push(audit)
      active.failedAction = undefined
      this.refreshElapsed(active.session)
      this.emit('changed', cloneSession(active.session))
      return { action: validated, screenshot, asset: audit.screenshot, audit }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      active.session.audit.push({
        id: randomUUID(),
        action: isComputerAction(action) ? auditAction(action) : { type: 'screenshot' },
        status: 'error',
        createdAt: Date.now(),
        detail: message
      })
      this.emit('changed', cloneSession(active.session))
      if (combined.signal.aborted) {
        this.stopConversation(conversationId, 'cancelled')
      } else if (this.recordFailure(active, validated)) {
        this.stopConversation(conversationId, 'repeated-failure')
      }
      throw error
    } finally {
      combined.dispose()
      active.inFlight = false
    }
  }

  private ensureWithinTime(active: ActiveSession): void {
    this.refreshElapsed(active.session)
    if (active.session.budget.elapsedMs >= active.session.budget.timeLimitMs) {
      this.stopConversation(active.session.conversationId, 'time-budget')
      throw new Error('The AI-control time limit has been reached.')
    }
  }

  private refreshTargetInfo(active: ActiveSession): void {
    const current = active.target.describe()
    if (current.id !== active.session.target.id) {
      this.stopConversation(active.session.conversationId, 'target-closed')
      throw new Error('The controlled target changed or is no longer available.')
    }
    active.session.target = current
  }

  private getActiveSession(conversationId: string): ActiveSession {
    const active = this.sessions.get(conversationId)
    if (!active) throw new Error('AI control is not enabled for this conversation.')
    if (active.session.status !== 'active') throw new Error('AI control is paused or has ended.')
    if (!active.target.isAlive()) {
      this.stopConversation(conversationId, 'target-closed')
      throw new Error('The controlled preview window was closed.')
    }
    return active
  }

  private refreshElapsed(session: ComputerControlSession): void {
    session.budget.elapsedMs = Math.max(0, (session.endedAt ?? Date.now()) - session.startedAt)
  }

  private recordError(
    active: ActiveSession,
    action: ComputerControlAuditAction,
    error: unknown
  ): void {
    const detail = error instanceof Error ? error.message : String(error)
    active.session.audit.push({
      id: randomUUID(),
      action,
      status: 'error',
      createdAt: Date.now(),
      detail
    })
    this.emit('changed', cloneSession(active.session))
  }

  private recordFailure(active: ActiveSession, action: ValidatedComputerAction): boolean {
    const signature = JSON.stringify(auditAction(action))
    if (active.failedAction?.signature === signature) active.failedAction.count += 1
    else active.failedAction = { signature, count: 1 }
    return active.failedAction.count >= COMPUTER_CONTROL_REPEATED_FAILURE_LIMIT
  }
}

export function validateComputerAction(
  value: unknown,
  target: { width: number; height: number }
): ValidatedComputerAction {
  if (!isComputerAction(value))
    throw new Error('Computer action must use a supported typed action.')
  const point = (value: unknown, name: string) => validatePoint(value, name, target)
  switch (value.type) {
    case 'screenshot':
      return value
    case 'click':
    case 'double_click':
      return { type: value.type, ...point(value, 'coordinate') }
    case 'drag':
      return {
        type: 'drag',
        from: point(value.from, 'drag start'),
        to: point(value.to, 'drag end'),
        ...(value.durationMs === undefined
          ? {}
          : {
              durationMs: boundedInteger(value.durationMs, 1, MAX_DRAG_DURATION_MS, 'drag duration')
            })
      }
    case 'scroll':
      return {
        type: 'scroll',
        deltaX:
          value.deltaX === undefined
            ? 0
            : boundedInteger(
                value.deltaX,
                -MAX_SCROLL_DELTA,
                MAX_SCROLL_DELTA,
                'horizontal scroll'
              ),
        deltaY: boundedInteger(value.deltaY, -MAX_SCROLL_DELTA, MAX_SCROLL_DELTA, 'vertical scroll')
      }
    case 'keypress':
      if (
        !Array.isArray(value.keys) ||
        value.keys.length === 0 ||
        value.keys.length > 4 ||
        !value.keys.every(isKey)
      ) {
        throw new Error('keypress requires one to four supported key names.')
      }
      return { type: 'keypress', keys: value.keys }
    case 'type':
      if (typeof value.text !== 'string' || !value.text || value.text.length > MAX_TYPED_CHARS) {
        throw new Error(`type requires 1-${MAX_TYPED_CHARS} characters.`)
      }
      return { type: 'type', text: value.text }
    case 'wait':
      return {
        type: 'wait',
        durationMs: boundedInteger(value.durationMs, 1, MAX_WAIT_MS, 'wait duration')
      }
  }
}

function validatePoint(
  value: unknown,
  name: string,
  target: { width: number; height: number }
): { x: number; y: number } {
  if (!value || typeof value !== 'object') throw new Error(`${name} must have x and y coordinates.`)
  const point = value as { x?: unknown; y?: unknown }
  return {
    x: boundedInteger(point.x, 0, Math.max(0, target.width - 1), `${name} x`),
    y: boundedInteger(point.y, 0, Math.max(0, target.height - 1), `${name} y`)
  }
}

function boundedInteger(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}.`)
  }
  return value
}

function isKey(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_+-]{1,32}$/.test(value)
}

function isComputerAction(value: unknown): value is ComputerAction {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    typeof (value as { type?: unknown }).type === 'string' &&
    ['screenshot', 'click', 'double_click', 'drag', 'scroll', 'keypress', 'type', 'wait'].includes(
      (value as { type: string }).type
    )
  )
}

function describeAction(action: ComputerAction): string {
  switch (action.type) {
    case 'click':
      return `Clicked ${action.x}, ${action.y}`
    case 'double_click':
      return `Double-clicked ${action.x}, ${action.y}`
    case 'drag':
      return `Dragged from ${action.from.x}, ${action.from.y} to ${action.to.x}, ${action.to.y}`
    case 'scroll':
      return `Scrolled ${action.deltaY}px`
    case 'keypress':
      return `Pressed ${action.keys.join(' + ')}`
    case 'type':
      return `Typed ${action.text.length} characters`
    case 'wait':
      return `Waited ${action.durationMs}ms`
    default:
      return 'Captured screenshot'
  }
}

function auditAction(action: ComputerAction): ComputerControlAuditAction {
  if (action.type === 'type') return { type: 'type', textLength: action.text.length }
  return action
}

function cloneSession(session: ComputerControlSession): ComputerControlSession {
  return {
    ...session,
    target: { ...session.target },
    budget: { ...session.budget },
    audit: [...session.audit]
  }
}

function raceSignals(
  first: AbortSignal,
  second?: AbortSignal
): { signal: AbortSignal; dispose(): void } {
  if (!second) return { signal: first, dispose: () => {} }
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  first.addEventListener('abort', abort, { once: true })
  second.addEventListener('abort', abort, { once: true })
  if (first.aborted || second.aborted) controller.abort()
  return {
    signal: controller.signal,
    dispose: () => {
      first.removeEventListener('abort', abort)
      second.removeEventListener('abort', abort)
    }
  }
}

export const computerControlService = new ComputerControlService()
