import type { ToolFactory } from './types'
import { randomUUID } from 'node:crypto'
import { enqueueVisualInput } from '../vision/imageInputs'
import { computerControlService } from '../computerControl/ComputerControlService'

/**
 * The model-facing half of Phase 1 control. The service accepts only the
 * typed schema below; it has no JavaScript, navigation, browser, or shell API.
 */
export const computerControlTool: ToolFactory = (define, ctx) => {
  const scope = computerControlService.get(ctx.conversationId)?.target.scope
  const surfaceDescription =
    scope === 'anodex-file-viewer'
      ? 'This Anodex File Viewer session permits only explicitly tagged Preview/Code, editor, and Save controls. Editor text, safe single editor keys, and Save require approval. Every other Anodex control is blocked.'
      : scope === 'project-preview'
        ? 'This project-preview session may follow a clicked link only to another workspace HTML page; every other navigation is blocked.'
        : scope === 'desktop'
          ? 'This Windows session is bound to one user-selected application window. Every action requires the user to approve it. It cannot control another window, protected sign-in/payment/password surfaces, or the operating system.'
          : 'This session is bound to one project-preview page; navigation is blocked.'
  return define({
    description: `Control the one user-enabled Anodex target using exactly one typed action. Coordinates are pixels in the latest screenshot. Every successful action returns a fresh screenshot. ${surfaceDescription} Never use this for external sites, downloads, uploads, passwords, secrets, shell commands, or any other window.`,
    params: {
      type: 'object',
      properties: {
        action: {
          oneOf: [
            { type: 'object', properties: { type: { const: 'screenshot' } }, required: ['type'] },
            {
              type: 'object',
              properties: {
                type: { const: 'click' },
                x: { type: 'integer' },
                y: { type: 'integer' }
              },
              required: ['type', 'x', 'y']
            },
            {
              type: 'object',
              properties: {
                type: { const: 'double_click' },
                x: { type: 'integer' },
                y: { type: 'integer' }
              },
              required: ['type', 'x', 'y']
            },
            {
              type: 'object',
              properties: {
                type: { const: 'drag' },
                from: { type: 'object' },
                to: { type: 'object' },
                durationMs: { type: 'integer' }
              },
              required: ['type', 'from', 'to']
            },
            {
              type: 'object',
              properties: {
                type: { const: 'scroll' },
                deltaX: { type: 'integer' },
                deltaY: { type: 'integer' }
              },
              required: ['type', 'deltaY']
            },
            {
              type: 'object',
              properties: {
                type: { const: 'keypress' },
                keys: { type: 'array', items: { type: 'string' } }
              },
              required: ['type', 'keys']
            },
            {
              type: 'object',
              properties: { type: { const: 'type' }, text: { type: 'string' } },
              required: ['type', 'text']
            },
            {
              type: 'object',
              properties: { type: { const: 'wait' }, durationMs: { type: 'integer' } },
              required: ['type', 'durationMs']
            }
          ]
        }
      },
      required: ['action']
    } as const,
    handler: async (args: { action: unknown }) => {
      const id = ctx.claimPendingToolCallId?.('computer_control') ?? randomUUID()
      const title = 'AI control action'
      ctx.emit({ id, name: 'computer_control', kind: 'read', title, status: 'running' })
      try {
        if (
          !ctx.visualInputs ||
          !computerControlService.hasActiveVisionSession(ctx.conversationId)
        ) {
          throw new Error('AI control is not available for this vision session.')
        }
        const assessment = await computerControlService.assess(
          ctx.conversationId,
          args.action,
          ctx.signal
        )
        if (assessment.approvalDetail) {
          const response = await ctx.confirm({
            id: randomUUID(),
            conversationId: ctx.conversationId,
            messageId: ctx.messageId,
            toolName: 'computer_control',
            kind: 'write',
            title: 'Approve AI control action',
            detail: assessment.approvalDetail,
            risk: 'sensitive',
            requiresHumanApproval: true
          })
          if (!response.approved) {
            const detail = response.reason?.trim()
              ? `Denied: ${response.reason.trim()}`
              : 'Denied by user'
            const audit = computerControlService.deny(ctx.conversationId, assessment.action, detail)
            ctx.emit({
              id,
              name: 'computer_control',
              kind: 'read',
              title,
              status: 'denied',
              detail,
              computerControl: audit
            })
            return `Computer action denied by the user${response.reason?.trim() ? `: ${response.reason.trim()}` : '.'}`
          }
        }
        const outcome = await computerControlService.perform(
          ctx.conversationId,
          ctx.messageId,
          assessment.action,
          ctx.signal
        )
        enqueueVisualInput(ctx.visualInputs, outcome.screenshot)
        ctx.emit({
          id,
          name: 'computer_control',
          kind: 'read',
          title,
          status: 'success',
          detail: outcome.audit.detail,
          result: outcome.audit.detail,
          computerControl: outcome.audit,
          preview: {
            kind: 'image',
            source: 'inspection',
            title: outcome.audit.detail,
            path: computerControlService.get(ctx.conversationId)?.target.path ?? 'preview',
            dataUrl: outcome.screenshot.dataUrl,
            mimeType: outcome.screenshot.mimeType,
            asset: outcome.asset
          }
        })
        return `${outcome.audit.detail}. A fresh screenshot is attached to the next model round.`
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.emit({
          id,
          name: 'computer_control',
          kind: 'read',
          title,
          status: 'error',
          detail: message,
          result: `Error: ${message}`
        })
        return `Error: ${message}`
      }
    }
  })
}
