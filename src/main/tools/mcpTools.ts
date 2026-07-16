import type { McpToolDescriptor } from '@shared/mcp.types'
import type { DefineChatSessionFunction, ToolFunction, ToolRuntimeContext } from './types'
import { runGuardedTool, runReadTool } from './helpers'
import { mcpManager } from '../mcp/McpManager'

/**
 * `defineChatSessionFunction`'s `params` is a literal-inferred `const Params`
 * generic (every hand-written tool satisfies it via `params: {...} as const`)
 * — that can't work here since an MCP server's JSON Schema is only known at
 * runtime. Recast `define` against a plain, non-generic signature instead of
 * fighting the generic inference; matches `ToolFunction`'s own
 * schema-agnostic `ChatSessionModelFunction<any>` (see types.ts) — same
 * escape hatch, applied at the one call site that actually needs it.
 */
type DefineMcpTool = (config: {
  description?: string
  params?: unknown
  handler: (args: Record<string, unknown>) => Promise<string>
}) => ToolFunction

/**
 * Builds one callable tool per discovered MCP tool. Params come straight
 * from the server's own JSON Schema `inputSchema` — Anodex does no schema
 * validation of its own beyond what the server enforces.
 *
 * Generic MCP calls remain sensitive because server annotations are only
 * hints. Trusted built-in presets may mark verified read-only calls as reads
 * and destructive calls as such; see `McpManager.toDescriptor`.
 */
export function buildMcpToolFunction(
  define: DefineChatSessionFunction,
  ctx: ToolRuntimeContext,
  descriptor: McpToolDescriptor
): ToolFunction {
  const defineMcpTool = define as unknown as DefineMcpTool
  return defineMcpTool({
    description: describeMcpTool(descriptor),
    params: descriptor.inputSchema,
    handler: (args) => {
      const run = async (): Promise<{ modelResult: string }> => ({
        modelResult: await mcpManager.callTool(descriptor.serverId, descriptor.toolName, args)
      })
      const base = {
        name: descriptor.qualifiedName,
        kind: 'mcp',
        title: `${descriptor.serverName}: ${descriptor.toolName}`,
        args
      } as const
      if (descriptor.readOnly) return runReadTool(ctx, { ...base, run })
      return runGuardedTool(ctx, {
        ...base,
        confirmDetail: describeMcpCall(descriptor, args),
        risk: descriptor.risk,
        forceConfirm: descriptor.forceConfirm,
        run
      })
    }
  })
}

function describeMcpTool(descriptor: McpToolDescriptor): string {
  const base = descriptor.description || `Call the "${descriptor.toolName}" tool.`
  return `[MCP: ${descriptor.serverName}] ${base}`
}

function describeMcpCall(descriptor: McpToolDescriptor, args: Record<string, unknown>): string {
  const argSummary = Object.keys(args).length ? JSON.stringify(args, null, 2) : '(no arguments)'
  return `${descriptor.serverName} → ${descriptor.toolName}\n\n${argSummary}`
}
