import { describe, expect, it, vi } from 'vitest'
import { guardToolHandlers } from '../guardedToolDefine'
import { ToolGuidanceError } from '../../tools/ToolGuidanceError'
import type { DefineChatSessionFunction } from '../../tools/types'

/**
 * A tool that throws must not take the turn with it.
 *
 * Measured on a 4B model running the email script at an 8K window, where most
 * of the catalog sits behind the deferred-tool gateway. The model passed
 * malformed JSON to `call_available_tool`, the gateway raised its guidance
 * error, and the run ended:
 *
 *   Autorun failed: ToolGuidanceError: argumentsJson must be a valid JSON
 *   object string.
 *
 * Seven prompts, zero completed — from a model that scores 10/10 on the chat
 * matrix. `LlamaVisionService` already turns this into a readable result the
 * model corrects itself from; `LlamaService` reaches tools through
 * node-llama-cpp's `defineChatSessionFunction`, which propagates the throw.
 */

/** Stands in for node-llama-cpp's define: hands back whatever it was given. */
const passthroughDefine = ((options: unknown) => options) as DefineChatSessionFunction

function handlerOf(tool: unknown): (...args: unknown[]) => Promise<unknown> {
  return (tool as { handler: (...args: unknown[]) => Promise<unknown> }).handler
}

describe('guardToolHandlers', () => {
  it('returns a guidance error as the call result instead of throwing', async () => {
    const define = guardToolHandlers(passthroughDefine)
    const tool = define({
      description: 'x',
      params: { type: 'object', properties: {} },
      handler: () => {
        throw new ToolGuidanceError('argumentsJson must be a valid JSON object string.')
      }
    } as never)

    await expect(handlerOf(tool)({})).resolves.toBe(
      'argumentsJson must be a valid JSON object string.'
    )
  })

  it('does the same for a genuine fault, so no tool can end a turn', async () => {
    // A real bug in a tool is still not a reason to destroy the conversation;
    // the model gets the message and the log keeps the stack.
    const define = guardToolHandlers(passthroughDefine)
    const tool = define({
      description: 'x',
      params: { type: 'object', properties: {} },
      handler: () => {
        throw new TypeError('cannot read properties of undefined')
      }
    } as never)

    await expect(handlerOf(tool)({})).resolves.toBe('cannot read properties of undefined')
  })

  it('handles a rejected promise, not just a synchronous throw', async () => {
    const define = guardToolHandlers(passthroughDefine)
    const tool = define({
      description: 'x',
      params: { type: 'object', properties: {} },
      handler: () => Promise.reject(new ToolGuidanceError('refused'))
    } as never)

    await expect(handlerOf(tool)({})).resolves.toBe('refused')
  })

  it('passes a successful result through untouched', async () => {
    const define = guardToolHandlers(passthroughDefine)
    const tool = define({
      description: 'x',
      params: { type: 'object', properties: {} },
      handler: () => Promise.resolve('the real answer')
    } as never)

    await expect(handlerOf(tool)({})).resolves.toBe('the real answer')
  })

  it('forwards the arguments the model supplied', async () => {
    const handler = vi.fn(() => Promise.resolve('ok'))
    const define = guardToolHandlers(passthroughDefine)
    const tool = define({
      description: 'x',
      params: { type: 'object', properties: {} },
      handler
    } as never)

    await handlerOf(tool)({ path: 'a.ts' })

    expect(handler).toHaveBeenCalledWith({ path: 'a.ts' })
  })

  it('keeps the rest of the tool definition intact', () => {
    // The wrapper replaces one field; description and schema are what the model
    // reads to decide whether to call at all.
    const define = guardToolHandlers(passthroughDefine)
    const tool = define({
      description: 'the description',
      params: { type: 'object', properties: { path: { type: 'string' } } },
      handler: () => Promise.resolve('ok')
    } as never) as unknown as { description: string; params: unknown }

    expect(tool.description).toBe('the description')
    expect(tool.params).toEqual({ type: 'object', properties: { path: { type: 'string' } } })
  })
})
