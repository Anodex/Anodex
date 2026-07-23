import type { ChatSessionModelFunction } from 'node-llama-cpp'
import type { DefineChatSessionFunction, ToolFunction } from '../tools/types'

const GATEWAY_TOOL_NAMES = [
  'find_available_tool',
  'describe_available_tool',
  'call_available_tool'
] as const

const MAX_FIND_DESCRIPTION_CHARS = 320
const MAX_SCHEMA_CHUNK_CHARS = 4_000

export interface BoundedToolSurface {
  functions: Record<string, ToolFunction>
  directToolNames: string[]
  deferredToolNames: string[]
  routed: boolean
}

interface DeferredToolBox {
  current: Record<string, ToolFunction>
}

interface Gateway {
  functions: Record<string, ToolFunction>
  deferred: DeferredToolBox
}

/**
 * Keep the complete tool catalog callable without documenting every full JSON
 * schema in the model's prompt. Direct tools retain native function calling;
 * deferred tools use a compact discover -> describe -> call gateway.
 */
export function boundToolSurface(options: {
  allFunctions: Record<string, ToolFunction> | undefined
  define: DefineChatSessionFunction
  routingText: string
  targetFixedTokens: number
  /** Maximum full native schemas; remaining tools stay available through the gateway. */
  maxDirectTools?: number
  measureFixedTokens: (functions: Record<string, ToolFunction> | undefined) => number
}): BoundedToolSurface {
  const {
    allFunctions,
    define,
    routingText,
    targetFixedTokens,
    maxDirectTools = Number.POSITIVE_INFINITY,
    measureFixedTokens
  } = options
  if (!allFunctions || Object.keys(allFunctions).length === 0) {
    return { functions: {}, directToolNames: [], deferredToolNames: [], routed: false }
  }

  const allNames = Object.keys(allFunctions)
  if (allNames.length <= maxDirectTools && measureFixedTokens(allFunctions) <= targetFixedTokens) {
    return {
      functions: allFunctions,
      directToolNames: allNames,
      deferredToolNames: [],
      routed: false
    }
  }

  const gateway = createDeferredToolGateway(define)
  const selected: Record<string, ToolFunction> = { ...gateway.functions }
  const directToolNames: string[] = []

  for (const name of rankToolNames(allFunctions, routingText)) {
    if (directToolNames.length >= maxDirectTools) break
    const candidate = { ...selected, [name]: allFunctions[name] }
    if (measureFixedTokens(candidate) > targetFixedTokens) continue
    selected[name] = allFunctions[name]
    directToolNames.push(name)
  }

  const directSet = new Set(directToolNames)
  const deferredToolNames = allNames.filter((name) => !directSet.has(name))
  gateway.deferred.current = Object.fromEntries(
    deferredToolNames.map((name) => [name, allFunctions[name]])
  )

  return {
    functions: selected,
    directToolNames,
    deferredToolNames,
    routed: true
  }
}

/** Rank likely-needed native schemas first; every other tool stays available through the gateway. */
export function rankToolNames(
  functions: Record<string, ToolFunction>,
  routingText: string
): string[] {
  const text = routingText.toLowerCase()
  const scores = new Map<string, number>()

  for (const [name, fn] of Object.entries(functions)) {
    let score = name === 'finish_goal' ? 10_000 : 0
    if (text.includes(name.toLowerCase())) score += 5_000
    score += categoryScore(name, text)
    score += lexicalScore(name, fn.description, text)
    scores.set(name, score)
  }

  return Object.keys(functions).sort((a, b) => {
    const difference = (scores.get(b) ?? 0) - (scores.get(a) ?? 0)
    return difference || a.localeCompare(b)
  })
}

function categoryScore(name: string, text: string): number {
  const readOnlyTask = hasAny(text, [
    'read-only',
    'read only',
    'do not edit',
    'without editing',
    'no file changes'
  ])
  const codeTask = hasAny(text, [
    'code',
    'file',
    'project',
    'repository',
    'repo',
    'typescript',
    'javascript',
    'bug',
    'architecture',
    'audit',
    'implement',
    'refactor'
  ])
  const changeTask =
    !readOnlyTask &&
    hasAny(text, [
      'fix',
      'change',
      'edit',
      'implement',
      'create',
      'write',
      'delete',
      'move',
      'rename',
      'refactor',
      'finish'
    ])
  const checkTask =
    !readOnlyTask &&
    hasAny(text, ['test', 'typecheck', 'lint', 'build', 'verify', 'command', 'run'])
  const webTask = hasAny(text, [
    'web',
    'search online',
    'research',
    'source',
    'url',
    'http',
    'latest'
  ])
  const emailTask = hasAny(text, ['email', 'gmail', 'inbox', 'attachment', 'thread', 'send mail'])
  const githubTask = hasAny(text, [
    'github',
    'pull request',
    'issue',
    'actions',
    'workflow',
    'commit'
  ])
  const skillTask = hasAny(text, ['skill', 'workflow instructions', 'playbook'])
  const memoryTask = hasAny(text, ['remember', 'my name', 'preference', 'later conversation'])

  if (codeTask && READ_TOOLS.has(name)) return 3_000
  if (changeTask && WRITE_TOOLS.has(name)) return 3_500
  if (checkTask && CHECK_TOOLS.has(name)) return 3_700
  if (webTask && WEB_TOOLS.has(name)) return 3_300
  if (emailTask && EMAIL_TOOLS.has(name)) return 3_300
  if (githubTask && isGithubTool(name)) return 3_400
  if (skillTask && SKILL_TOOLS.has(name)) return 3_200
  if (memoryTask && name === 'remember_fact') return 3_200
  if (codeTask && PLAN_TOOLS.has(name)) return 2_000
  return 0
}

function lexicalScore(name: string, description: string | undefined, text: string): number {
  const words = `${name.replaceAll('_', ' ')} ${description ?? ''}`
    .toLowerCase()
    .match(/[a-z0-9]{3,}/g)
  if (!words) return 0
  let matches = 0
  for (const word of new Set(words)) {
    if (text.includes(word)) matches += 1
  }
  return Math.min(900, matches * 90)
}

function hasAny(text: string, terms: readonly string[]): boolean {
  return terms.some((term) => text.includes(term))
}

function isGithubTool(name: string): boolean {
  return name.toLowerCase().includes('github') || name.toLowerCase().startsWith('github__')
}

function createDeferredToolGateway(define: DefineChatSessionFunction): Gateway {
  const deferred: DeferredToolBox = { current: {} }
  const defineGateway = define as unknown as (config: {
    description: string
    params: unknown
    handler: (args: Record<string, unknown>) => unknown
  }) => ChatSessionModelFunction

  const find = defineGateway({
    description:
      'Search tools whose full schemas were deferred to save context. Use this when the needed native tool is not already available, then call describe_available_tool before call_available_tool.',
    params: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A short description of the capability needed.' }
      },
      required: ['query']
    },
    handler: (args) => findDeferredTools(deferred.current, stringArgument(args.query))
  })

  const describe = defineGateway({
    description:
      'Return a bounded chunk of the exact description and JSON parameter schema for one deferred tool. Start at offset 0 and request the next offset when more remains. Call this before call_available_tool so its arguments are correct.',
    params: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact tool name returned by find_available_tool.' },
        offset: {
          type: 'integer',
          description:
            'Character offset for paging a large schema. Omit or use 0 for the first chunk.'
        }
      },
      required: ['name']
    },
    handler: (args) =>
      describeDeferredTool(
        deferred.current,
        stringArgument(args.name),
        nonNegativeIntegerArgument(args.offset)
      )
  })

  const call = defineGateway({
    description:
      'Call one deferred tool after reading its schema with describe_available_tool. Pass argumentsJson as a JSON object string. The original tool keeps its normal approval and safety checks.',
    params: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact deferred tool name.' },
        argumentsJson: {
          type: 'string',
          description: 'A JSON object string matching the schema from describe_available_tool.'
        }
      },
      required: ['name', 'argumentsJson']
    },
    handler: (args) =>
      callDeferredTool(
        deferred.current,
        stringArgument(args.name),
        stringArgument(args.argumentsJson)
      )
  })

  return {
    functions: {
      [GATEWAY_TOOL_NAMES[0]]: find,
      [GATEWAY_TOOL_NAMES[1]]: describe,
      [GATEWAY_TOOL_NAMES[2]]: call
    },
    deferred
  }
}

function findDeferredTools(functions: Record<string, ToolFunction>, query: string): string {
  const terms = query.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []
  const ranked = Object.entries(functions)
    .map(([name, fn]) => {
      const haystack = `${name.replaceAll('_', ' ')} ${fn.description ?? ''}`.toLowerCase()
      const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0)
      return {
        name,
        description: truncate(fn.description ?? 'No description.', MAX_FIND_DESCRIPTION_CHARS),
        score
      }
    })
    .filter((item) => terms.length === 0 || item.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 8)

  if (ranked.length === 0) return 'No deferred tools matched. Try a broader capability query.'
  return ranked.map((item) => `${item.name} — ${item.description}`).join('\n')
}

function describeDeferredTool(
  functions: Record<string, ToolFunction>,
  name: string,
  offset: number
): string {
  const tool = functions[name]
  if (!tool) return `No deferred tool named "${name}". Use find_available_tool first.`
  const parameters: unknown = tool.params
  const serialized = JSON.stringify(
    {
      name,
      description: tool.description ?? '',
      parameters: parameters ?? { type: 'object', properties: {} }
    },
    null,
    2
  )
  const safeOffset = Math.min(offset, serialized.length)
  const chunk = serialized.slice(safeOffset, safeOffset + MAX_SCHEMA_CHUNK_CHARS)
  const nextOffset = safeOffset + chunk.length
  const paging =
    nextOffset < serialized.length
      ? `Schema chunk ${safeOffset}-${nextOffset - 1} of ${serialized.length} characters. Request offset ${nextOffset} next.\n`
      : `Final schema chunk ${safeOffset}-${Math.max(safeOffset, nextOffset - 1)} of ${serialized.length} characters.\n`
  return `${paging}${chunk}`
}

async function callDeferredTool(
  functions: Record<string, ToolFunction>,
  name: string,
  argumentsJson: string
): Promise<unknown> {
  const tool = functions[name]
  if (!tool) throw new Error(`No deferred tool named "${name}". Use find_available_tool first.`)

  let args: unknown
  try {
    args = JSON.parse(argumentsJson) as unknown
  } catch {
    throw new Error('argumentsJson must be a valid JSON object string.')
  }
  if (args == null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('argumentsJson must decode to a JSON object.')
  }
  const schema: unknown = tool.params
  const validationError = validateAgainstSchema(args, schema)
  if (validationError) {
    throw new Error(
      `Arguments for "${name}" do not match its schema: ${validationError} ` +
        'Call describe_available_tool and try again.'
    )
  }
  return await tool.handler(args)
}

function stringArgument(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function nonNegativeIntegerArgument(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value
}

function validateAgainstSchema(value: unknown, schema: unknown, path = 'arguments'): string | null {
  if (schema == null || typeof schema !== 'object') return null
  const definition = schema as Record<string, unknown>

  if ('const' in definition && !Object.is(definition.const, value)) {
    return `${path} must equal ${String(definition.const)}`
  }
  if (Array.isArray(definition.enum) && !definition.enum.includes(value)) {
    return `${path} must be one of ${definition.enum.map(String).join(', ')}`
  }
  if (definition.type === 'object') {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
      return `${path} must be an object`
    }
    const objectValue = value as Record<string, unknown>
    const required = Array.isArray(definition.required)
      ? definition.required.filter((item): item is string => typeof item === 'string')
      : []
    for (const key of required) {
      if (!(key in objectValue)) return `${path}.${key} is required`
    }
    const properties =
      definition.properties && typeof definition.properties === 'object'
        ? (definition.properties as Record<string, unknown>)
        : {}
    for (const [key, childSchema] of Object.entries(properties)) {
      if (!(key in objectValue)) continue
      const error = validateAgainstSchema(objectValue[key], childSchema, `${path}.${key}`)
      if (error) return error
    }
  } else if (definition.type === 'array') {
    if (!Array.isArray(value)) return `${path} must be an array`
    for (let i = 0; i < value.length; i++) {
      const error = validateAgainstSchema(value[i], definition.items, `${path}[${i}]`)
      if (error) return error
    }
  } else if (definition.type === 'string' && typeof value !== 'string') {
    return `${path} must be a string`
  } else if (definition.type === 'number' && typeof value !== 'number') {
    return `${path} must be a number`
  } else if (
    definition.type === 'integer' &&
    (typeof value !== 'number' || !Number.isInteger(value))
  ) {
    return `${path} must be an integer`
  } else if (definition.type === 'boolean' && typeof value !== 'boolean') {
    return `${path} must be a boolean`
  }
  return null
}

const READ_TOOLS = new Set([
  'list_directory',
  'read_file',
  'read_file_range',
  'read_multiple_files',
  'preview_html',
  'inspect_visual',
  'get_file_info',
  'search_files',
  'find_files',
  'code_outline',
  'search_code',
  'git_status',
  'git_diff',
  'git_commit_summary'
])

const WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'patch_file',
  'delete_file',
  'move_file',
  'create_directory',
  'delete_directory',
  'update_project_notes',
  'propose_change',
  'update_change_task',
  'archive_change',
  'list_changes'
])

const CHECK_TOOLS = new Set(['run_command', 'run_project_check', 'git_status', 'git_diff'])
const WEB_TOOLS = new Set(['web_search', 'fetch_url'])
const EMAIL_TOOLS = new Set([
  'list_threads',
  'search_email',
  'read_email',
  'summarize_thread',
  'find_attachments',
  'draft_email',
  'send_email',
  'save_email_attachment'
])
const SKILL_TOOLS = new Set(['find_skill', 'load_skill'])
const PLAN_TOOLS = new Set(['write_plan', 'update_plan_step'])
