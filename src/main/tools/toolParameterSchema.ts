import type { ToolFunction } from './types'

/**
 * One tool's parameter schema, rendered for a provider that takes plain JSON
 * Schema — Anthropic's `input_schema`, OpenAI's `parameters`, and the same
 * field on every OpenAI-compatible vendor and the local llama-server transport.
 *
 * Extracted because it existed four times over, and three of those copies
 * carried the same wrong rule (see below) with the same comment explaining it.
 * A policy about how Anodex describes its tools to a model belongs in one
 * place; duplicating it is what let a single mistake ship four times.
 *
 * The node-llama-cpp text path is deliberately not a caller: it hands
 * `ToolFunction['params']` to node-llama-cpp untouched and never renders JSON
 * Schema at all.
 */
export interface ToolParameterSchema {
  type: 'object'
  properties: Record<string, unknown>
  required: string[]
  /**
   * The SDKs type their schema fields as open records (`FunctionParameters`,
   * `Anthropic.Tool.InputSchema`), so this needs an index signature to be
   * assignable to them. Declared rather than reached for: nothing here writes
   * a key outside the three above.
   */
  [key: string]: unknown
}

/**
 * Render a tool's declared parameters, honouring the `required` list the tool
 * itself declares.
 *
 * Three providers used to overwrite that with `Object.keys(properties)` — every
 * property mandatory — on the stated grounds that node-llama-cpp's grammar
 * always requires every declared property regardless of the schema (a real GBNF
 * limitation), "so every Anodex tool is written assuming that behavior".
 *
 * The tools say otherwise. Every one of them declares a narrow `required` list
 * that matches its handler's non-optional arguments exactly, and the optional
 * ones are typed `?` with documented defaults behind `??`. `search_code`
 * declares `required: ['query']` and resolves `args.limit ?? DEFAULT_TOP_K`;
 * `git_status` declares no required list at all because its only parameter is
 * an *optional* subdirectory. Forcing those mandatory does not make a model
 * supply better arguments — it makes it invent a value for a parameter it
 * should have omitted, and then the documented default never applies.
 *
 * `required` entries naming a property that doesn't exist are dropped: a
 * schema that requires a field it never declares is one some providers reject
 * outright, and it can only be a typo in the tool definition.
 */
export function toolParameterSchema(params: ToolFunction['params']): ToolParameterSchema {
  const schema = (params ?? {}) as {
    properties?: Record<string, unknown>
    required?: readonly string[]
  }
  const properties = schema.properties ?? {}
  return {
    type: 'object',
    properties,
    required: (schema.required ?? []).filter((key) => key in properties)
  }
}
