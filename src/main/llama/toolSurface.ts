import type { ChatSessionModelFunction } from 'node-llama-cpp'
import type { DefineChatSessionFunction, ToolFunction } from '../tools/types'

const GATEWAY_TOOL_NAMES = [
  'find_available_tool',
  'describe_available_tool',
  'call_available_tool'
] as const

/**
 * Native schemas `boundToolSurface` always adds for the deferred-tool gateway.
 *
 * Exported because a caller sizing a reserve before the surface exists has to
 * account for them, and `LlamaVisionService` was doing that against its own
 * hardcoded `3`. Derived from the list above so the two cannot drift.
 */
export const GATEWAY_TOOL_COUNT = GATEWAY_TOOL_NAMES.length

/**
 * How many tools may keep a full native schema at a given context size. Small
 * contexts rely more heavily on the deferred gateway to preserve working room.
 *
 * Lives here rather than in each transport: it is the single knob deciding how
 * much of the catalog a model is told about directly, and both transports had
 * their own byte-identical copy of it with nothing keeping them in step.
 */
export function maxDirectToolsForContext(contextSize: number): number {
  return Math.max(6, Math.min(16, Math.floor(Math.max(0, contextSize) / 4_096) + 6))
}

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
  targetFixedTokens: number
  /** Maximum full native schemas; remaining tools stay available through the gateway. */
  maxDirectTools?: number
  measureFixedTokens: (functions: Record<string, ToolFunction> | undefined) => number
}): BoundedToolSurface {
  const {
    allFunctions,
    define,
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

  for (const name of rankToolNames(allFunctions)) {
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

/**
 * A small deterministic builder core. User or model wording never changes the
 * available native schemas; every non-core capability remains reachable via
 * the deferred gateway. This makes context cost stable across providers and
 * prevents keyword collisions from promoting an unrelated domain such as
 * email into a coding turn.
 */
/**
 * Ordered so that the first ten entries are a *complete* builder loop —
 * orient, read, locate, edit, run — rather than the ten most obvious tools. On
 * a small window only about that many keep a native schema, and a surface that
 * can read but not edit is what produced the 157-call, zero-write message in
 * `docs/CONTEXT_SYSTEM_ROOT_CAUSE.md`.
 *
 * Two placements are deliberate and worth not "tidying" later:
 *
 * - `replace_lines` outranks `edit_file` because it is the edit a model can
 *   still make once its reads have been evicted; `edit_file` needs text it may
 *   no longer hold. Both stay available.
 * - `code_outline` outranks `read_file` because structure-per-token is what a
 *   tight window needs first, and reading a whole file is what exhausts it.
 */
const DIRECT_TOOL_PRIORITY = [
  'finish_goal',
  'list_directory',
  'read_file_range',
  'search_files',
  'code_outline',
  'replace_lines',
  'edit_file',
  'write_file',
  // Immediately after `write_file`, always. `write_file`'s own description
  // tells the model to write a first chunk and append the rest when a file is
  // too long to emit at once — so offering it without `append_file` instructs
  // the model to begin an operation it cannot finish.
  // That happened: a 41,455-byte file was overwritten with a 1,839-byte first
  // chunk, `append_file` was deferred behind the gateway, zero appends
  // followed, and the file was left truncated and unparseable.
  'append_file',
  'run_command',
  'read_file',
  'find_files',
  'patch_file',
  'inspect_visual',
  'preview_html',
  'show_image',
  'create_directory',
  'run_project_check',
  'git_diff',
  'git_status',
  'read_multiple_files',
  'get_file_info',
  'search_code',
  'write_plan',
  'update_plan_step',
  'fetch_url',
  'web_search',
  'remember_fact',
  'update_project_notes',
  'git_commit_summary',
  'generate_image'
] as const

const DIRECT_TOOL_RANK = new Map<string, number>(
  DIRECT_TOOL_PRIORITY.map((name, index) => [name, index])
)

/** Order native schemas without interpreting the task's prose. */
export function rankToolNames(functions: Record<string, ToolFunction>): string[] {
  return Object.keys(functions).sort((a, b) => {
    const aRank = DIRECT_TOOL_RANK.get(a) ?? Number.POSITIVE_INFINITY
    const bRank = DIRECT_TOOL_RANK.get(b) ?? Number.POSITIVE_INFINITY
    return aRank - bRank || a.localeCompare(b)
  })
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
  const terms = discoveryTerms(query)
  if (terms.length === 0) {
    return 'No deferred tools matched. Name the specific object or domain you need, not only a generic action such as read, search, or list.'
  }
  const ranked = Object.entries(functions)
    .map(([name, fn]) => {
      const haystack = new Set(
        discoveryWords(`${name.replaceAll('_', ' ')} ${fn.description ?? ''}`)
      )
      const score = terms.reduce((sum, term) => sum + (haystack.has(term) ? 1 : 0), 0)
      return {
        name,
        description: truncate(fn.description ?? 'No description.', MAX_FIND_DESCRIPTION_CHARS),
        score
      }
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 8)

  if (ranked.length === 0) return 'No deferred tools matched. Try a broader capability query.'
  return ranked.map((item) => `${item.name} — ${item.description}`).join('\n')
}

/** Generic verbs cannot distinguish `read_file` from `read_email`. */
const DISCOVERY_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'available',
  'call',
  'check',
  'find',
  'for',
  'get',
  'in',
  'list',
  'look',
  'open',
  'read',
  'search',
  'show',
  'the',
  'to',
  'tool',
  'tools',
  'use',
  'with'
])

function discoveryTerms(value: string): string[] {
  return [...new Set(discoveryWords(value).filter((word) => !DISCOVERY_STOP_WORDS.has(word)))]
}

function discoveryWords(value: string): string[] {
  return (value.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []).map((word) =>
    word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word
  )
}

function describeDeferredTool(
  functions: Record<string, ToolFunction>,
  name: string,
  offset: number
): string {
  const resolvedName = resolveDeferredToolName(functions, name)
  const tool = functions[resolvedName]
  if (!tool) return `No deferred tool named "${name}". Use find_available_tool first.`
  const parameters: unknown = tool.params
  const serialized = JSON.stringify(
    {
      name: resolvedName,
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
  const resolvedName = resolveDeferredToolName(functions, name)
  const tool = functions[resolvedName]
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
      `Arguments for "${resolvedName}" do not match its schema: ${validationError} ` +
        'Call describe_available_tool and try again.'
    )
  }
  return await tool.handler(args)
}

/** Recover a known name from harmless wrapper punctuation emitted by weaker local models. */
function resolveDeferredToolName(functions: Record<string, ToolFunction>, name: string): string {
  const trimmed = name.trim()
  if (functions[trimmed]) return trimmed
  const unwrapped = trimmed.replace(/^[`"'<>]+|[`"'<>]+$/g, '')
  return functions[unwrapped] ? unwrapped : trimmed
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
