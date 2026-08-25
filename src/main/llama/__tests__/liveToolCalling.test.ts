import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import * as nlc from 'node-llama-cpp'
import { resolveToolCallingWrapper, fabricatedResultStopTriggers } from '../toolCallDialects'
import { detectFallbackToolCall } from '../toolCallFallback'
import * as MARKERS from '@shared/deepSeekMarkers'

/**
 * End-to-end tool-calling probe against a real local GGUF.
 *
 * Every other test here checks a parser or a settings object in isolation, and
 * all of them passed while live turns were still producing confident fiction —
 * the failures live in the seam between the model's output and node-llama-cpp's
 * reader, which only a real model exercises. This runs one scripted task that
 * cannot be completed without two *sequential* calls (the second's arguments
 * depend on the first's result), which is exactly the shape that was broken:
 * the first call of a section ran natively and later ones leaked as prose.
 *
 * Opt-in, because it loads a multi-gigabyte model and needs the GPU to itself:
 *
 *   ANODEX_PROBE_MODEL="C:/path/to/model.gguf" npx vitest run liveToolCalling
 *
 * `ANODEX_PROBE_GPU_LAYERS=0` forces CPU, for running it beside a loaded app.
 * `ANODEX_PROBE_DUMP=<file>` writes the raw reply and the executed calls there,
 * which is the first thing worth reading when a new model fails this.
 */
const MODEL_PATH = process.env.ANODEX_PROBE_MODEL
const CONTEXT_SIZE = Number(process.env.ANODEX_PROBE_CONTEXT ?? 8192)

/** A tiny fake workspace, so the model's calls have real results to work from. */
const FILES: Record<string, string[]> = {
  'index.html': [
    '<!doctype html>',
    '<script type="module" src="js/sandbox.js"></script>',
    '<div id="app"></div>'
  ],
  'js/sandbox.js': [
    "import * as THREE from 'three.module.js';",
    'const scene = new THREE.Scene();',
    'export { scene };'
  ]
}

interface RecordedCall {
  name: string
  args: Record<string, unknown>
}

describe.skipIf(!MODEL_PATH)('live tool calling', () => {
  let model: nlc.LlamaModel
  let context: nlc.LlamaContext

  beforeAll(async () => {
    const llama = await nlc.getLlama({ build: 'never', logLevel: nlc.LlamaLogLevel.error })
    const gpuLayers = process.env.ANODEX_PROBE_GPU_LAYERS
    model = await llama.loadModel({
      modelPath: MODEL_PATH!,
      ...(gpuLayers === undefined ? {} : { gpuLayers: Number(gpuLayers) })
    })
    context = await model.createContext({ contextSize: CONTEXT_SIZE })
  }, 600_000)

  // Deliberately no teardown. Disposing a multi-gigabyte model took the vitest
  // worker down with it on a 27B (`Worker exited unexpectedly`, reported as an
  // unhandled error after the test had already passed) — a probe that cries
  // failure on a model that actually worked is worse than no probe. The run is
  // a short-lived process of its own; exiting reclaims everything.

  it('carries a read-then-edit task through to a real change', async () => {
    const calls: RecordedCall[] = []

    const functions = {
      list_files: nlc.defineChatSessionFunction({
        description: 'List every file in the workspace. Call this first.',
        params: { type: 'object', properties: {}, required: [] } as const,
        handler: () => {
          calls.push({ name: 'list_files', args: {} })
          return JSON.stringify({ files: Object.keys(FILES) })
        }
      }),
      read_file: nlc.defineChatSessionFunction({
        description: 'Read one file from the workspace by its exact path.',
        params: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Path from list_files.' } },
          required: ['path']
        } as const,
        handler: (args: { path: string }) => {
          calls.push({ name: 'read_file', args })
          const lines = FILES[args.path]
          return lines
            ? JSON.stringify({ path: args.path, lines })
            : JSON.stringify({ error: `No such file: ${args.path}` })
        }
      }),
      edit_file: nlc.defineChatSessionFunction({
        description: 'Replace one exact line of a file with new text. Use this to change code.',
        params: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path of the file to change.' },
            oldLine: { type: 'string', description: 'The exact line to replace.' },
            newLine: { type: 'string', description: 'What to put in its place.' }
          },
          required: ['path', 'oldLine', 'newLine']
        } as const,
        handler: (args: { path: string; oldLine: string; newLine: string }) => {
          calls.push({ name: 'edit_file', args })
          const lines = FILES[args.path]
          if (!lines) return JSON.stringify({ error: `No such file: ${args.path}` })
          const index = lines.findIndex((line) => line.trim() === args.oldLine.trim())
          if (index === -1) return JSON.stringify({ error: 'That line is not in the file.' })
          lines[index] = args.newLine
          return JSON.stringify({ changed: args.path })
        }
      })
    }

    const architecture = model.fileInfo?.metadata?.general?.architecture
    const template = model.fileInfo?.metadata?.tokenizer?.chat_template
    // `ANODEX_PROBE_WRAPPER` overrides the resolved choice, so a model's
    // options can be compared head to head: `auto` (default) is what Anodex
    // would really do, `none` forces node-llama-cpp's own resolution, and
    // `no-template` forces the dialect's purpose-built wrapper.
    const override = process.env.ANODEX_PROBE_WRAPPER ?? 'auto'
    const chatWrapper =
      override === 'none'
        ? undefined
        : override === 'no-template'
          ? resolveToolCallingWrapper(nlc, architecture, undefined)
          : resolveToolCallingWrapper(nlc, architecture, template)

    const session = new nlc.LlamaChatSession({
      contextSequence: context.getSequence(),
      ...(chatWrapper ? { chatWrapper: chatWrapper as nlc.ChatWrapper } : {})
    })

    // Mirrors what `LlamaService` does around a turn: when generation stops at
    // a fabricated-result marker, ask once for the call that was skipped. The
    // engine's own loop is bounded the same way.
    const promptOptions = {
      functions,
      maxParallelFunctionCalls: 1 as const,
      maxTokens: 900,
      temperature: 0,
      customStopTriggers: fabricatedResultStopTriggers(architecture)
    }
    const NUDGE =
      'You started writing a tool result yourself. Tool results come only from the ' +
      'tools — anything you write there is invented. Call the tool you need and wait ' +
      'for its real result, or, if the task is already done, say what you did.'

    const answer = await session.prompt(
      'The .js file in this workspace uses an ES module import, which does not work here. ' +
        'List the files, read the .js one, then edit it so it uses the global `THREE` ' +
        'instead of importing it. Use the tools for every step; do not guess file contents.',
      promptOptions
    )

    // Up to two corrective rounds, the same shape and bound as the engine's.
    let reply = answer
    for (let round = 0; round < 2 && calls.length < 3; round++) {
      reply = await session.prompt(NUDGE, promptOptions)
    }

    if (process.env.ANODEX_PROBE_DUMP) {
      fs.writeFileSync(
        process.env.ANODEX_PROBE_DUMP,
        JSON.stringify(
          { architecture, usedWrapper: chatWrapper?.constructor?.name, calls, answer },
          null,
          2
        )
      )
    }

    // Order, not an exact transcript: a model that re-reads the file to check
    // its own edit is behaving well, and pinning the precise sequence would
    // fail it for that. What must hold is that each call could only have been
    // written from the previous one's real result.
    const names = calls.map((call) => call.name)
    const firstRead = names.indexOf('read_file')
    const firstEdit = names.indexOf('edit_file')

    expect(names[0]).toBe('list_files')
    expect(firstRead).toBeGreaterThan(0)
    expect(firstEdit).toBeGreaterThan(firstRead)
    // The path is only knowable from `list_files`, the line only from the read.
    expect(calls[firstRead].args.path).toBe('js/sandbox.js')
    expect(calls[firstEdit].args.oldLine).toContain('import')

    // And the edit has to have actually landed. This is the shape that failed
    // in the field: the model read a file, said it would make the change, and
    // the turn ended having written nothing.
    expect(FILES['js/sandbox.js'][0]).not.toContain('import')

    // Nothing the wrapper should have consumed may reach the transcript. Tested
    // by marker rather than by comparing against the stripped text, since the
    // stripper also collapses blank runs and that is not a defect.
    for (const marker of Object.values(MARKERS)) {
      expect(reply).not.toContain(marker)
    }
    // And no unexecuted call may be left sitting in the reply as prose.
    expect(detectFallbackToolCall(reply, new Set(Object.keys(functions)))).toBeNull()
  }, 600_000)
})
