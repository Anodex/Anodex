import type { ToolFactory } from './types'
import { runGuardedTool, runReadTool } from './helpers'
import { findKeyTarget, KEY_TARGETS, maskKey } from '../secrets/keyTargets'

const SERVICES = KEY_TARGETS.map((target) => target.id).join(', ')

function unknownService(service: string): Promise<string> {
  return Promise.resolve(`Anodex does not keep keys for "${service}". It can for: ${SERVICES}.`)
}

/**
 * request_key — ask the person for a key in a box in the chat.
 *
 * The key goes from that box to the main process, is checked against the
 * service, and is stored encrypted; the model only learns whether it worked.
 * It needs the person in every mode, because they are the one who has the key,
 * and unattended runs refuse it.
 */
export const requestKeyTool: ToolFactory = (define, ctx) =>
  define({
    description: `Ask the person for an API key or token in a secure box in the chat, then check it and save it encrypted. You never see the key. Use when setting up a service that needs one. Services: ${SERVICES}.`,
    params: {
      type: 'object',
      properties: {
        service: { type: 'string', description: `Which service: ${SERVICES}.` }
      },
      required: ['service']
    } as const,
    handler: (args: { service: string }) => {
      const target = findKeyTarget(args.service)
      if (!target) return unknownService(args.service)
      return runGuardedTool(ctx, {
        name: 'request_key',
        kind: 'write',
        title: `Add your ${target.name} key`,
        args,
        confirmDetail: target.getUrl
          ? `Get one at ${target.getUrl}, then paste it here. It is checked, then stored encrypted on this computer.`
          : 'Paste it here. It is checked, then stored encrypted on this computer.',
        risk: 'sensitive',
        requiresHumanApproval: true,
        confirmSecret: {
          service: target.name,
          getUrl: target.getUrl,
          placeholder: target.placeholder
        },
        async run(_progress, confirmation) {
          const key = confirmation?.secretValue?.trim() ?? ''
          if (!key) {
            return {
              modelResult: `No ${target.name} key was entered. Ask the person if they want to try again later.`,
              detail: 'no key entered',
              madeProgress: false
            }
          }
          return { modelResult: await target.checkAndSave(key), detail: `${target.name} saved` }
        }
      })
    }
  })

/**
 * save_key — store a key the person pasted into the chat.
 *
 * Asks in Ask and Edits mode and goes ahead in Untethered, as the person asked
 * for. One rule holds in every mode: the key must appear in something the
 * person typed in this chat. A key the model read in a web page or a file is
 * refused, so content Anodex looked at cannot swap the person's search or
 * GitHub key for one it controls. After saving, the chat drops the key from
 * its copy of the message.
 */
export const saveKeyTool: ToolFactory = (define, ctx) =>
  define({
    description: `Save an API key or token the person pasted into this chat, after checking it works. Only a key the person typed or pasted themselves can be saved. Services: ${SERVICES}.`,
    params: {
      type: 'object',
      properties: {
        service: { type: 'string', description: `Which service: ${SERVICES}.` },
        key: { type: 'string', description: 'The key exactly as the person pasted it.' }
      },
      required: ['service', 'key']
    } as const,
    handler: (args: { service: string; key: string }) => {
      const target = findKeyTarget(args.service)
      if (!target) return unknownService(args.service)
      const key = args.key.trim()
      if (!key || !ctx.userProvided?.(key)) {
        return runReadTool(ctx, {
          name: 'save_key',
          kind: 'read',
          title: `Save ${target.name} key`,
          args: { service: args.service },
          run: () =>
            Promise.resolve({
              modelResult: `Refused: that key does not appear in anything the person typed in this chat, so it was not saved. Only a key the person pasted themselves can be stored. Use request_key to ask them for it.`,
              madeProgress: false
            })
        })
      }
      return runGuardedTool(ctx, {
        name: 'save_key',
        kind: 'write',
        title: `Save ${target.name} key`,
        // Never the key itself: this is what the transcript keeps.
        args: { service: args.service },
        confirmDetail: `Save the ${target.name} key you pasted (${maskKey(key)}) after checking it works. It is stored encrypted on this computer.`,
        risk: 'sensitive',
        async run() {
          const result = await target.checkAndSave(key)
          ctx.onSecretSaved?.(key)
          return { modelResult: result, detail: `${target.name} saved` }
        }
      })
    }
  })
