import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelInfo } from '@shared/model.types'
import type { GenerateParams } from '../LlamaService'

/**
 * End-to-end reasoning-overrun recovery against a **real** llama-server.
 *
 * `LlamaVisionService.test.ts` scripts the stream, so it pins the logic but
 * cannot tell you whether the assumptions under it are true of the real
 * server: that reasoning arrives as `reasoning_content` deltas, that a round
 * spending everything on reasoning reports `finish_reason: "length"`, and that
 * a model told to stop deliberating will actually go on to call a tool. All
 * three were assumptions until this probe checked them.
 *
 * What it measured, on Qwen3.6-27B and Qwen3.8-27B Q4_K_M at a 32,768 context.
 * Before the fix: a 900-token round produced ~3,200 characters of reasoning,
 * zero visible text, zero tool calls, and `finish_reason: "length"` — the dead
 * round that used to end the whole turn and send the bounded runner into a
 * fresh cycle that restarted the same task. After it, with the server started
 * at `--reasoning-budget 819`: reasoning closes at 3,123 characters and the
 * *same* round goes on to emit a real `write_file` call. See
 * `reasoningOverrun.ts`.
 *
 * **The server must be started with the budget**, exactly as
 * `LlamaServerRuntime` now starts it — that flag is what is under test, and
 * without it this probe reproduces the original failure instead.
 *
 * Opt-in, like `liveToolCalling`, because it needs a loaded model. Unlike that
 * probe it does not spawn its own server — point it at one you already have:
 *
 *   ANODEX_LIVE_SERVER=http://127.0.0.1:18777/v1 \
 *   ANODEX_LIVE_KEY=<api key> \
 *   ANODEX_LIVE_MODEL_ID=<the id /v1/models reports> \
 *   npx vitest run liveReasoningRecovery
 *
 * Start one the way Anodex does (see `LlamaServerRuntime.start`):
 *
 *   resources/llama-server/win32-x64/llama-server.exe --model <gguf>
 *     --mmproj <mmproj> --ctx-size 32768 --host 127.0.0.1 --port 18777
 *     --api-key <key> --parallel 1 --jinja --no-webui --n-gpu-layers 999
 *     --reasoning-budget 819
 */
const BASE_URL = process.env.ANODEX_LIVE_SERVER
const API_KEY = process.env.ANODEX_LIVE_KEY ?? 'none'

const workspace = mkdtempSync(join(tmpdir(), 'anodex-live-reasoning-'))

const mocks = vi.hoisted(() => ({
  toolCalls: [] as Array<{ name: string; args: unknown }>,
  /** Ends the turn as soon as the write under test has landed. */
  stopWhenWritten: null as (() => void) | null
}))

// The one piece replaced: process management. The HTTP client, the round loop,
// the budget, the reasoning cut and the recovery are all the real thing —
// replacing the OpenAI client here would defeat the entire point of the probe.
vi.mock('../LlamaServerRuntime', () => ({
  LlamaServerRuntime: class {
    activeConnection: unknown = {
      baseUrl: process.env.ANODEX_LIVE_SERVER,
      apiKey: process.env.ANODEX_LIVE_KEY ?? 'none',
      modelId: process.env.ANODEX_LIVE_MODEL_ID ?? 'model'
    }
    start(): Promise<unknown> {
      return Promise.resolve(this.activeConnection)
    }
    stop(): Promise<void> {
      return Promise.resolve()
    }
    settleExit(): Promise<void> {
      return Promise.resolve()
    }
    describeUnexpectedStop(): undefined {
      return undefined
    }
    /** The server's own tokenizer, so the output budget is measured for real. */
    async countTokens(text: string): Promise<number | null> {
      const response = await fetch(`${BASE_URL}/../tokenize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({ content: text })
      }).catch(() => null)
      if (!response?.ok) return null
      const body = (await response.json()) as { tokens?: unknown[] }
      return Array.isArray(body.tokens) ? body.tokens.length : null
    }
    recentOutput(): string {
      return ''
    }
  }
}))

vi.mock('../../tools/registry', () => ({
  buildTools: () => ({
    write_file: {
      description: 'Create or overwrite a text file in the workspace.',
      params: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the workspace root.' },
          content: { type: 'string', description: 'The complete file contents.' }
        },
        required: ['path', 'content']
      },
      handler: async (args: { path: string; content: string }) => {
        mocks.toolCalls.push({ name: 'write_file', args })
        const { writeFile, mkdir } = await import('node:fs/promises')
        const target = join(workspace, args.path)
        await mkdir(join(target, '..'), { recursive: true })
        await writeFile(target, args.content, 'utf-8')
        // The question this probe asks is answered the moment a real call
        // lands. Letting the turn run on to its natural end asks a different
        // and much slower one — the first version did, and timed out at 30
        // minutes on a CPU-bound box *after* the write it was checking for had
        // already succeeded.
        mocks.stopWhenWritten?.()
        return `Wrote ${args.content.length} characters to ${args.path}.`
      }
    }
  })
}))

vi.mock('../../models/ModelReliabilityStore', () => ({
  modelReliabilityStore: { recordToolCall: () => {}, recordFabrication: () => {} }
}))

const { LlamaVisionService } = await import('../LlamaVisionService')

const TEST_MODEL: ModelInfo = {
  id: 'live',
  name: 'Live probe model',
  path: 'live.gguf',
  sizeBytes: 1,
  source: 'local'
}

/**
 * A request that reliably induces a long deliberation before any action, which
 * is what the fix has to survive. Deliberately not adversarial — this is an
 * ordinary "design it properly, then build it" instruction of the kind the
 * driving conversation was full of.
 */
const PROMPT =
  'Design and then create `camera.py`: a 3D orbit camera for a universe sandbox, with ' +
  'yaw/pitch orbit, zoom, pan, perspective projection, depth sorting and screen-space ' +
  'picking. Reason through every case carefully before you act, then write the file. ' +
  'Keep this first version under 60 lines.'

describe.skipIf(!BASE_URL)('live reasoning-overrun recovery', () => {
  it('reaches a real tool call on a request that reasons past its budget', async () => {
    mocks.toolCalls.length = 0
    const finished = new AbortController()
    mocks.stopWhenWritten = () => finished.abort()
    const service = new LlamaVisionService(undefined, () => TEST_MODEL)
    await service.load({
      path: 'live.gguf',
      visionProjectorPath: 'live-mmproj.gguf',
      contextSize: 32_768
    })

    const outcome = await service.generate({
      conversationId: 'c_live',
      messageId: 'm_live',
      systemPrompt:
        'You are Anodex, a coding assistant. Use tools to make changes — never describe ' +
        'an edit instead of making it.',
      history: [],
      prompt: PROMPT,
      onToken: () => {},
      signal: finished.signal,
      tools: { workspaceRoot: workspace } as unknown as GenerateParams['tools'],
      // A tight ceiling on purpose: it is the shape of a late round in a long
      // turn, where the reasoning budget has to leave room for the call out of
      // very little. A round with a comfortable ceiling is the easy case.
      options: { maxTokens: 2_500 }
    })

    // The assertion that matters: the turn produced a real change. Before the
    // fix the first round was the last one, and nothing was written.
    expect(mocks.toolCalls.map((call) => call.name)).toContain('write_file')
    const written = mocks.toolCalls.find((call) => call.name === 'write_file')!.args as {
      path: string
      content: string
    }
    expect(existsSync(join(workspace, written.path))).toBe(true)
    expect(readFileSync(join(workspace, written.path), 'utf-8').length).toBeGreaterThan(0)
    // And it is a genuine attempt, not a stub emitted to satisfy the nudge.
    expect(written.content.length).toBeGreaterThan(200)

    console.log('live reasoning recovery:', {
      roundsToFirstWrite: mocks.toolCalls.length,
      writtenPath: written.path,
      writtenChars: written.content.length,
      // The number that moved: this was the entire round's output before, with
      // nothing left over to call a tool with.
      thinkingChars: outcome.thinking?.length ?? 0,
      tokens: outcome.stats.tokens,
      seconds: Math.round(outcome.stats.durationMs / 1000)
    })
    // Sized for one round, not one turn — the handler above ends the turn at
    // the first write. A 27B on CPU generates ~2.8 tokens/second, so a
    // 2,500-token round is roughly 15 minutes; 10 was not enough and cut the
    // probe off mid-round, which reads as a failure without being one.
  }, 1_500_000)
})
