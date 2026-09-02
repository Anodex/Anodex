import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { ChatHistoryTurn, ChatRequest } from '@shared/chat.types'
import type { ToolCall } from '@shared/tools.types'
import { llamaService } from '../llama/LlamaService'
import { ensureLocalModelLoaded } from '../llama/ensureLocalModelLoaded'
import { describeModel } from '../llama/modelScanner'
import { resolveModelContextSize } from '@shared/modelContextSize'
import { settingsStore } from '../settings/SettingsStore'
import { projectStore } from '../projects/ProjectStore'
import { headlessConfirm } from '../tools/headlessConfirm'
import { runBoundedChatGeneration } from './boundedChatRunner'
import { createLogger } from '../utils/logger'
import type { Conversation } from '@shared/conversation.types'
import { conversationStore } from '../conversations/ConversationStore'

const log = createLogger('chat:autorun')

/**
 * Development-only harness: hold a scripted conversation and report what came
 * back, so ordinary chat can be measured without driving the GUI.
 *
 * The third sibling of `agentAutorun.ts` and `criticalThinkingAutorun.ts`,
 * built for the same reason. Agent runs and Critical Thinking each had one and
 * were measured constantly; plain chat had none, and was consequently the least
 * measured surface in the app despite being the one every user hits first.
 *
 * Nothing here changes how a turn behaves: it calls `runBoundedChatGeneration`,
 * exactly as `chat.handlers.ts` does, with the same headless approval policy
 * the other unattended runs use. It only removes the typing.
 *
 * Multi-turn by design. A single prompt cannot exercise history replay,
 * compaction, or a tool result surviving into a later turn — the parts of chat
 * most likely to be wrong and least likely to be noticed.
 *
 * Inert unless `ANODEX_CHAT_AUTORUN` points at a script file, and refuses to
 * arm in a packaged build.
 */
export function initChatAutorun(): void {
  const scriptPath = process.env.ANODEX_CHAT_AUTORUN?.trim()
  if (!scriptPath) return
  if (process.env.NODE_ENV === 'production') {
    log.warn('Autorun ignored in a packaged build.')
    return
  }
  void driveChat(scriptPath)
}

/**
 * What the script file holds: the prompts to send, in order.
 *
 * `project` is matched by name, like the agent harness, because ids are
 * generated and a script is written by hand.
 */
interface ChatAutorunScript {
  prompts: string[]
  /** Project name, as shown in the sidebar. Omit for a general chat. */
  project?: string
  /** Tool names this conversation may use. Omit for the standard set. */
  enabledTools?: string[]
  /**
   * Tool names this run may answer the human-approval prompt for. Omit — and
   * you almost always should — to keep `headlessConfirm`'s refusal.
   *
   * This is a stand-in for a person clicking Approve, and it exists because
   * there is no other way to exercise a human-gated path automatically: the
   * approval is a callback the renderer answers, so `send_email` can only ever
   * be reached from a UI or from something pretending to be one. Without it,
   * the outward-facing half of email is the one part of Anodex that can never
   * be regression-tested, which is a poor place to have a blind spot.
   *
   * Three things keep it honest. It is an allowlist of specific tool names, so
   * a script that wants to test sending does not also gain permission to run a
   * destructive command. It lives only in the autorun harness, which refuses to
   * arm in a packaged build. And arming it logs a warning naming every tool it
   * covers, so a run that could send mail says so in its own log.
   *
   * Never add this to a script that mails anyone but a test address the user
   * has explicitly nominated.
   */
  approveHumanGatedCalls?: string[]
}

const POLL_MS = 2000
const MODEL_READY_TIMEOUT_MS = 15 * 60 * 1000

async function driveChat(scriptPath: string): Promise<void> {
  try {
    const script = JSON.parse(readFileSync(scriptPath, 'utf-8')) as ChatAutorunScript
    if (!script.prompts?.length) throw new Error(`${scriptPath} lists no prompts.`)
    log.info('Autorun armed:', script.prompts.length, 'prompt(s)')

    // A run that can answer a human-approval prompt says so, loudly, in its own
    // log. If a test ever mails someone unexpectedly, this line is what shows
    // whether the run was ever permitted to — and its absence is what shows a
    // run was not. See `ChatAutorunScript.approveHumanGatedCalls`.
    const approvable = new Set(script.approveHumanGatedCalls ?? [])
    if (approvable.size > 0) {
      log.warn('Human-approval gate stubbed for:', [...approvable].join(', '))
    }
    const confirm: typeof headlessConfirm = (request) =>
      request.requiresHumanApproval && approvable.has(request.toolName)
        ? Promise.resolve({ approved: true })
        : headlessConfirm(request)

    const settings = settingsStore.get()
    if (settings.provider.active === 'local') {
      // Ask for the model rather than waiting for the renderer to restore it —
      // see `ensureLocalModelLoaded` for the runs that waited forever.
      const loaded = await ensureLocalModelLoaded({
        status: llamaService.getState().status,
        lastModelPath: settings.lastModelPath,
        describeModel,
        loadModel: (options, info) => llamaService.loadModel(options, info),
        contextSize: resolveModelContextSize(settings, settings.lastModelPath ?? null)
      })
      log.info('Local model:', loaded)
      // Fail now rather than in fifteen minutes. `ensureLocalModelLoaded`
      // reports why it could not start, and every one of these states is
      // terminal — waiting for `ready` after a load failure just burns the
      // timeout before reporting the same thing. Found the slow way: a corrupt
      // .gguf in a model matrix cost a quarter of an hour per row.
      if (
        loaded === 'load-failed' ||
        loaded === 'model-file-missing' ||
        loaded === 'no-model-configured'
      ) {
        throw new Error(`Model not available (${loaded}) — see the llama log lines above.`)
      }
      await waitFor(() => llamaService.getState().status === 'ready', MODEL_READY_TIMEOUT_MS)
    }

    const conversationId = `chat_autorun_${Date.now().toString(36)}`
    const projectId = resolveProjectId(script.project)
    const history: ChatHistoryTurn[] = []

    // Persisted so the run is readable in Anodex itself, not only in a dev log.
    // Every scripted conversation used to exist purely as log lines: the work
    // being measured was invisible in the app it was measuring, so there was no
    // way to open a run and see how it actually read. `origin: 'autorun'` marks
    // it as machine-driven, the same way scheduled and agent chats are marked.
    const conversation: Conversation = {
      id: conversationId,
      projectId,
      title: `Autorun · ${basename(scriptPath)}`,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      origin: 'autorun'
    }
    conversationStore.save(conversation)

    for (const [index, prompt] of script.prompts.entries()) {
      const request: ChatRequest = {
        conversationId,
        messageId: randomUUID(),
        projectId,
        history: [...history],
        prompt
      }

      const started = Date.now()
      // Tool calls arrive through `onActivity` rather than on the result, so
      // they are collected here the same way the IPC handler forwards them.
      //
      // The whole call is kept, not just its name, because the next turn needs
      // it: `messageToHistoryTurn` puts `toolCalls` on every assistant turn the
      // real chat path replays, and this harness used to push only role and
      // content. That gap had teeth. A send test told the user "Sent", was
      // asked "did that actually send?", could not see its own call in the
      // replayed history, confabulated "I never called the send tool", and sent
      // the email a second time. Two identical messages arrived. The model was
      // working from a history that real chat would never have given it.
      const calls: string[] = []
      const toolCalls: ToolCall[] = []
      let refused = 0
      const result = await runBoundedChatGeneration(request, {
        // Same surface the IPC handler passes, so the harness measures the
        // prompt real chat actually gets rather than the agent one.
        surface: 'chat',
        // The tool set belongs on the io, not the request: `ChatRequest` has no
        // `enabledTools` field, so an earlier version setting it there behind a
        // cast did nothing at all and every run silently used the full catalog.
        //
        // Undefined is the right default rather than `buildRunToolNames()`,
        // because undefined is exactly what `chat.handlers.ts` passes — the full
        // catalog minus the user's disabled tools. A harness that narrowed the
        // set would stop measuring the thing it exists to measure. A script
        // naming `enabledTools` opts into a narrower set on purpose, which is
        // how the compaction script denies itself memory tools.
        enabledTools: script.enabledTools ? new Set(script.enabledTools) : undefined,
        confirm,
        onActivity: (call) => {
          calls.push(call.name)
          // Last write wins per id: a call is reported when it starts and again
          // when it settles, and the settled one carries the real status.
          const existing = toolCalls.findIndex((item) => item.id === call.id)
          if (existing === -1) toolCalls.push(call)
          else toolCalls[existing] = call
          if (String(call.detail ?? '').startsWith('Blocked:')) refused++
        }
      })
      const seconds = Math.round((Date.now() - started) / 1000)

      // One line per turn, deliberately: a scripted conversation is read as a
      // sequence, and a wall of streamed tokens hides the shape of it.
      log.info(
        `TURN ${index + 1}/${script.prompts.length} | ${seconds}s` +
          ` | ${result.content?.length ?? 0} chars` +
          ` | ${calls.length} call(s)${refused ? ` (${refused} refused)` : ''}` +
          ` | ${result.stats?.tokens ?? 0} tokens` +
          ` | stop=${result.stopReason ?? 'none'}` +
          (calls.length ? ` | tools: ${[...new Set(calls)].join(',')}` : '')
      )
      log.info(`PROMPT ${index + 1}: ${prompt.slice(0, 120)}`)
      // Long enough to grade against, not just to eyeball. `chat-criteria.mjs`
      // matches on the whole reply, and a routing or refusal sentence often
      // lands after an opening paragraph — a 400-character cap scored those
      // as absent when they were simply off the end of the line.
      log.info(`REPLY ${index + 1}: ${(result.content ?? '').replace(/\s+/g, ' ').slice(0, 2500)}`)

      // Fed back as history so the next turn sees this one, which is the whole
      // point of scripting more than one.
      history.push({ role: 'user', content: prompt })
      // `toolCalls` carried forward exactly as `messageToHistoryTurn` does for
      // the real chat path, so the next turn can see what this one actually did
      // rather than only what it said about it.
      history.push({
        role: 'assistant',
        content: result.content ?? '',
        toolCalls: toolCalls.length > 0 ? [...toolCalls] : undefined
      })

      // Saved after every turn rather than once at the end, so a run that is
      // still going — or one that dies halfway — can still be opened and read.
      const now = Date.now()
      conversation.messages.push(
        { id: randomUUID(), role: 'user', content: prompt, createdAt: now },
        {
          id: randomUUID(),
          role: 'assistant',
          content: result.content ?? '',
          createdAt: now,
          toolCalls: toolCalls.length > 0 ? [...toolCalls] : undefined
        }
      )
      conversation.updatedAt = now
      conversationStore.save(conversation)
    }

    log.info('CHAT AUTORUN COMPLETE')
  } catch (error) {
    log.error('Autorun failed:', error)
  }
}

/** Fail loudly on an unknown project name, like the agent harness does. */
function resolveProjectId(name: string | undefined): string | null {
  if (!name) return null
  const match = projectStore.getState().projects.find((project) => project.name === name)
  if (!match) {
    const known = projectStore
      .getState()
      .projects.map((project) => project.name)
      .join(', ')
    throw new Error(`No project named "${name}". Known projects: ${known}`)
  }
  return match.id
}

async function waitFor(done: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the model to become ready.')
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}
