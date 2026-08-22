import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import * as nlc from 'node-llama-cpp'
import { resolveToolCallingWrapper } from '../toolCallDialects'
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

  it('runs both calls of a task that needs two sequential tools', async () => {
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
      })
    }

    const architecture = model.fileInfo?.metadata?.general?.architecture
    const template = model.fileInfo?.metadata?.tokenizer?.chat_template
    const chatWrapper = resolveToolCallingWrapper(nlc, architecture, template)

    const session = new nlc.LlamaChatSession({
      contextSequence: context.getSequence(),
      ...(chatWrapper ? { chatWrapper: chatWrapper as nlc.ChatWrapper } : {})
    })

    const answer = await session.prompt(
      'List the files in the workspace, then read the one that ends in .js. ' +
        'Use the tools; do not guess the contents.',
      { functions, maxParallelFunctionCalls: 1, maxTokens: 600, temperature: 0 }
    )

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

    // The second call is the point: its argument can only come from the first
    // call's result, so it cannot be produced by a model that never saw one.
    expect(calls.map((call) => call.name)).toEqual(['list_files', 'read_file'])
    expect(calls[1].args.path).toBe('js/sandbox.js')

    // Nothing the wrapper should have consumed may reach the transcript. Tested
    // by marker rather than by comparing against the stripped text, since the
    // stripper also collapses blank runs and that is not a defect.
    for (const marker of Object.values(MARKERS)) {
      expect(answer).not.toContain(marker)
    }
    // And no unexecuted call may be left sitting in the reply as prose.
    expect(detectFallbackToolCall(answer, new Set(Object.keys(functions)))).toBeNull()
  }, 600_000)
})
