import { ToolGuidanceError } from '../tools/ToolGuidanceError'
import type { DefineChatSessionFunction } from '../tools/types'
import { createLogger } from '../utils/logger'

const log = createLogger('llama:tool-guard')

/**
 * The shape a tool definition has, as far as this wrapper needs to care.
 *
 * Written out rather than derived with `Parameters<DefineChatSessionFunction>`:
 * node-llama-cpp's signature is generic over the parameter schema, so that
 * lookup collapses to `never` and nothing can be read off it. Only `handler` is
 * touched here; everything else is carried through untouched.
 */
interface ToolDefinitionLike {
  handler: (...args: unknown[]) => unknown
}

/**
 * Wrap a tool `define` so a handler that throws returns the message instead.
 *
 * ## The failure
 *
 * Measured on a 4B model running the email script at an 8K window. Small
 * windows put most of the catalog behind the `find_available_tool` /
 * `describe_available_tool` / `call_available_tool` gateway, and the gateway
 * validates what the model passes it. The model sent malformed JSON, the
 * gateway raised its guidance error — and the whole turn died:
 *
 *   Autorun failed: ToolGuidanceError: argumentsJson must be a valid JSON
 *   object string.
 *
 * Seven prompts, zero completed. The same model scores 10/10 on the chat
 * matrix, so this is not a weak model failing generally; it is one malformed
 * call taking the conversation with it.
 *
 * ## Why it only happened here
 *
 * `LlamaVisionService` already catches this exactly where it invokes a handler,
 * returning the message so the model reads it, corrects itself and continues —
 * and its comment says so. `LlamaService` reaches tools through
 * node-llama-cpp's own `defineChatSessionFunction`, which propagates a throw
 * out of generation, so the same guidance error that is a gentle nudge on one
 * transport is fatal on the other.
 *
 * A `ToolGuidanceError` is the design working: the tool is telling the model it
 * called wrongly. It should never end a turn. Wrapping `define` puts the guard
 * on one seam that every tool passes through — native and gateway alike —
 * rather than asking each of forty-odd tool factories to remember.
 */
export function guardToolHandlers(define: DefineChatSessionFunction): DefineChatSessionFunction {
  const rawDefine = define as unknown as (definition: ToolDefinitionLike) => unknown
  const guarded = (definition: ToolDefinitionLike): unknown => {
    const original = definition.handler
    return rawDefine({
      ...definition,
      handler: async (...args: unknown[]): Promise<unknown> => {
        try {
          return await original(...args)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          // The same split the vision transport uses: guidance is expected
          // traffic and logs quietly, a genuine fault keeps its stack.
          if (error instanceof ToolGuidanceError) {
            log.debug('Tool refused the call:', message)
          } else {
            log.error('Tool threw:', error)
          }
          // Returned, not rethrown. The model sees it as the call's result and
          // gets the chance to fix its arguments, which is the entire point of
          // a guidance error.
          return message
        }
      }
    })
  }
  return guarded as unknown as DefineChatSessionFunction
}
