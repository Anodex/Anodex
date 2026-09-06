import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decideRemoteChannel } from '../channelPolicy'

/**
 * What `Anodex/anodex-mobile` relies on, asserted here so it cannot be broken from
 * this side without anyone noticing.
 *
 * ## Why this file exists
 *
 * Two bugs, both found by a user on a real phone, both the same shape:
 *
 * - The phone sent `content` where `ChatRequest` requires `prompt`, and no
 *   `history`. Every message was rejected outright.
 * - The phone read `modelName` off `EngineState`, which has no such field, so the
 *   connection header stayed blank.
 *
 * Neither is visible from the desktop. The renderer never sends those shapes, the
 * typechecker has nothing to check them against, and the phone is a separate
 * repository that cannot participate in this build. The generated protocol
 * artifact exists precisely to close that gap — but only if something reads it.
 *
 * This is that something. It is deliberately about *field names the phone depends
 * on*, not about the whole surface: a name changing here is a runtime failure over
 * there, in another room, with no stack trace anyone sees.
 *
 * **When this fails**, the fix is usually to update the phone too, not to loosen
 * the test. A red build is the cheapest possible place to find this out.
 */

interface ProtocolType {
  kind?: string
  $ref?: string
  of?: ProtocolType[]
  properties?: Record<string, { optional: boolean; type: ProtocolType }>
}

interface Protocol {
  channels: Array<{
    channel: string
    kind: 'invoke' | 'event'
    args?: Array<{ name: string; optional: boolean; type: ProtocolType }>
    result?: ProtocolType
    payload?: ProtocolType
  }>
  definitions: Record<string, ProtocolType>
}

const protocol = JSON.parse(
  readFileSync(join(__dirname, '../../../../protocol/anodex-protocol.json'), 'utf8')
) as Protocol

function channel(name: string) {
  const found = protocol.channels.find((c) => c.channel === name)
  expect(found, `${name} is missing from the protocol the phone is built against`).toBeDefined()
  return found!
}

/** The declared fields of a type, following one `$ref` if that is what it is. */
function fieldsOf(type: ProtocolType | undefined): Record<string, { optional: boolean }> {
  if (!type) return {}
  const resolved = type.$ref ? protocol.definitions[type.$ref] : type
  return resolved?.properties ?? {}
}

function requiredFieldsOf(type: ProtocolType | undefined): string[] {
  return Object.entries(fieldsOf(type))
    .filter(([, value]) => !value.optional)
    .map(([name]) => name)
    .sort()
}

describe('the contract Anodex Mobile is built against', () => {
  describe('chat:send', () => {
    it('requires exactly the fields the phone sends', () => {
      // The phone builds this by hand in ChatSession.request(). Adding a required
      // field here breaks it silently until someone tries to send a message.
      expect(requiredFieldsOf(channel('chat:send').args?.[0]?.type)).toEqual([
        'conversationId',
        'history',
        'messageId',
        'prompt'
      ])
    })

    it('takes the project as an optional field named projectId', () => {
      // Without this the phone's turns are plain chat rather than work on files —
      // which is not a failure anyone sees, it just does the wrong kind of work.
      const fields = fieldsOf(channel('chat:send').args?.[0]?.type)
      expect(fields.projectId).toBeDefined()
      expect(fields.projectId.optional).toBe(true)
    })

    it('history turns carry role and content', () => {
      expect(requiredFieldsOf({ $ref: 'ChatHistoryTurn' })).toEqual(['content', 'role'])
    })
  })

  describe('chat:stream', () => {
    it('carries the fields the phone matches tokens on', () => {
      // The phone drops a chunk whose conversationId does not match the open one,
      // so a rename here would show as tokens silently going nowhere.
      expect(requiredFieldsOf(channel('chat:stream').payload)).toEqual([
        'conversationId',
        'messageId',
        'token'
      ])
    })
  })

  describe('models:get-state', () => {
    it('exposes the model and context fields the connection header reads', () => {
      const fields = fieldsOf(channel('models:get-state').result)
      for (const name of ['model', 'contextSize', 'contextTokensUsed']) {
        expect(fields[name], `EngineState.${name} is what the phone header reads`).toBeDefined()
      }
      expect(fieldsOf({ $ref: 'ModelInfo' }).name).toBeDefined()
    })
  })

  describe('conversations', () => {
    it('list returns conversations with the fields the phone lists and opens', () => {
      const fields = fieldsOf({ $ref: 'Conversation' })
      for (const name of ['id', 'title', 'messages', 'createdAt', 'updatedAt']) {
        expect(fields[name], `Conversation.${name}`).toBeDefined()
      }
    })

    it('save requires exactly what the phone writes back', () => {
      // The phone constructs a whole Conversation to persist a turn. A new required
      // field means every save from the phone starts failing.
      expect(requiredFieldsOf(channel('conversations:save').args?.[0]?.type)).toEqual([
        'createdAt',
        'id',
        'messages',
        'projectId',
        'title',
        'updatedAt'
      ])
    })

    it('a stored message carries role and content', () => {
      const fields = fieldsOf({ $ref: 'ChatMessage' })
      for (const name of ['id', 'role', 'content', 'createdAt']) {
        expect(fields[name], `ChatMessage.${name}`).toBeDefined()
      }
    })
  })

  describe('projects', () => {
    it('list returns which project is active', () => {
      const fields = fieldsOf(channel('projects:list').result)
      expect(fields.projects).toBeDefined()
      expect(fields.activeProjectId).toBeDefined()
    })

    it('a project carries the name and path the picker shows', () => {
      const fields = fieldsOf({ $ref: 'Project' })
      for (const name of ['id', 'name', 'folderPath']) {
        expect(fields[name], `Project.${name}`).toBeDefined()
      }
    })
  })

  describe('tool approvals', () => {
    it('the request carries the fields the phone renders and answers with', () => {
      const fields = fieldsOf(channel('tools:confirm-request').payload)
      for (const name of ['id', 'conversationId', 'toolName', 'title', 'risk']) {
        expect(fields[name], `ToolConfirmRequest.${name}`).toBeDefined()
      }
    })

    it('responding takes the id and a response', () => {
      const args = channel('tools:confirm-response').args ?? []
      expect(args).toHaveLength(2)
      expect(args[0].name).toBe('id')
    })
  })

  describe('the channels the phone is allowed to use', () => {
    it('every channel the phone calls is permitted', () => {
      // A denylist fails open, so this is the other half of that bet: the phone's
      // own dependencies asserted individually, rather than trusted to a prefix.
      const used = [
        'chat:send',
        'chat:stop',
        'conversations:list',
        'conversations:save',
        'projects:list',
        'projects:set-active',
        'models:get-state',
        'tools:confirm-response'
      ]
      for (const name of used) {
        expect(decideRemoteChannel(name), `${name} must stay reachable`).toEqual({ allowed: true })
      }
    })

    it('and the dangerous ones still are not', () => {
      for (const name of ['terminal:write', 'computer-control:start', 'remote:set-enabled']) {
        expect(decideRemoteChannel(name).allowed, `${name} must stay refused`).toBe(false)
      }
    })
  })
})
